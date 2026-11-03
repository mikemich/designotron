// Stock photo search: a "Photos" section in Assets (click a photo to fill the selection or place
// it) and the same list inside the image fill popover ("Find a photo…", which picks one photo).
// Results come straight from the provider in the browser (see src/photos); the chosen photo is
// downloaded, re-encoded and stored as an asset with its licence credit on the paint.

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import "./photos.css";
import { SelectField } from "../ui/controls";
import { selection, getDoc, toast } from "../store";
import { viewportCenter } from "../actions";
import { fillLayers, fillable, placeNewLayer } from "../photos/place";
import {
  PhotoError,
  PROVIDERS,
  searchPhotos,
  type Orientation,
  type PhotoResult,
  type ProviderId,
} from "../photos/providers";
import { availableProviders, getKey, getNonCommercial, getProvider, photoEnv, setKey, setNonCommercial, setProvider } from "../photos/settings";

const PAGE_SIZE = 12;
const DEBOUNCE_MS = 400;
const MIN_AUTO_CHARS = 3;

type Mode = { kind: "panel" } | { kind: "pick"; onPick: (r: PhotoResult) => Promise<void> };

type State =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "ok"; hasMore: boolean }
  | { s: "empty" }
  | { s: "error"; error: PhotoError | Error };

export function PhotoSearch(props: { mode: Mode }) {
  const [query, setQuery] = useState("");
  const [orientation, setOrientation] = useState<Orientation | "any">("any");
  const [provider, setProviderState] = useState<ProviderId>(getProvider);
  const [nc, setNc] = useState(getNonCommercial);
  const [pexelsKey, setPexelsKey] = useState(() => getKey("pexels"));
  const [sources, setSources] = useState(false);
  const [results, setResults] = useState<PhotoResult[]>([]);
  const [state, setState] = useState<State>({ s: "idle" });
  const [searched, setSearched] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [focus, setFocus] = useState(0);
  const run = useRef(0);
  /** The search the list shows, so typing that ends in Enter doesn't search twice. */
  const lastKey = useRef("");
  const searchKey = (text: string) => [text, orientation, provider, nc].join("|");
  const grid = useRef<HTMLUListElement>(null);
  const providers = availableProviders();
  const online = useOnline();

  const search = (q: string, page: number) => {
    const text = q.trim();
    if (!text) return;
    const mine = ++run.current;
    if (page === 1) {
      setSearched(text);
      lastKey.current = searchKey(text);
    }
    setState({ s: "loading" });
    searchPhotos(photoEnv(), { provider, query: text, orientation: orientation === "any" ? undefined : orientation, count: PAGE_SIZE, page })
      .then((r) => {
        if (mine !== run.current) return;
        const all = page === 1 ? r.results : [...results, ...r.results.filter((x) => !results.some((y) => y.id === x.id))];
        setResults(all);
        setFocus((f) => (page === 1 ? 0 : Math.min(f, all.length - 1)));
        setState(all.length ? { s: "ok", hasMore: r.hasMore } : { s: "empty" });
        setLive(all.length ? `${all.length} photos for ${text}` : `No photos for ${text}`);
      })
      .catch((error) => {
        if (mine !== run.current) return;
        setState({ s: "error", error });
        setLive(describe(error));
      });
  };
  const pages = useRef(1);

  // Searching again as the person types (3+ characters), and when a filter changes.
  useEffect(() => {
    if (query.trim().length < MIN_AUTO_CHARS) return;
    const t = setTimeout(() => {
      if (searchKey(query.trim()) === lastKey.current) return;
      pages.current = 1;
      search(query, 1);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, orientation, provider, nc]);

  const choose = async (r: PhotoResult, newLayer: boolean) => {
    if (busy) return;
    setBusy(r.id);
    try {
      if (props.mode.kind === "pick") {
        await props.mode.onPick(r);
        setLive(`Picked ${r.title}`);
      } else {
        const targets = newLayer ? [] : selection().filter((id) => fillable(getDoc().nodes[id]));
        if (targets.length) {
          const done = await fillLayers(r, targets);
          const msg = `Filled ${done.length === 1 ? getDoc().nodes[done[0]]?.name ?? "layer" : `${done.length} layers`} with "${short(r.title)}"`;
          toast(msg);
          setLive(msg);
        } else {
          const c = viewportCenter();
          await placeNewLayer(r, { x: c.x, y: c.y });
          toast(`Placed "${short(r.title)}"`);
          setLive(`Placed ${short(r.title)}`);
        }
      }
    } catch (err) {
      const msg = describe(err);
      toast(msg, "error");
      setLive(msg);
    } finally {
      setBusy(null);
    }
  };

  const onKey = (e: React.KeyboardEvent, i: number, r: PhotoResult) => {
    const cols = Math.max(1, getComputedStyle(grid.current!).gridTemplateColumns.split(" ").length);
    let next = i;
    if (e.key === "ArrowRight") next = i + 1;
    else if (e.key === "ArrowLeft") next = i - 1;
    else if (e.key === "ArrowDown") next = i + cols;
    else if (e.key === "ArrowUp") next = i - cols;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = results.length - 1;
    else if (e.key === "Enter" && e.shiftKey && props.mode.kind === "panel") {
      e.preventDefault();
      void choose(r, true);
      return;
    } else return;
    e.preventDefault();
    next = Math.max(0, Math.min(results.length - 1, next));
    setFocus(next);
    (grid.current?.querySelectorAll("button.photo-tile")[next] as HTMLElement | undefined)?.focus();
  };

  const loadMore = () => {
    pages.current += 1;
    search(searched, pages.current);
  };

  const label = (r: PhotoResult) => `${props.mode.kind === "pick" ? "Use" : "Fill with"} '${short(r.title)}' by ${r.author || "unknown"}, ${r.license}${r.nonCommercial ? ", non-commercial" : ""}`;
  const err = state.s === "error" ? state.error : null;
  const hint = useMemo(
    () => (err instanceof PhotoError && err.kind === "rateLimited" && provider === "openverse" ? "Add a free Pexels key under Sources and keys to keep searching." : ""),
    [err, provider],
  );

  return (
    <div className="photos" data-testid="photo-search">
      <div className="photo-searchbox">
        <Search size={13} aria-hidden />
        <input
          className="textinput"
          type="search"
          placeholder="Search photos"
          aria-label="Search photos"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              pages.current = 1;
              search(query, 1);
            }
          }}
        />
      </div>
      <div className="row photo-filters">
        <SelectField
          ariaLabel="Photo orientation"
          value={orientation}
          options={[
            { value: "any", label: "Any shape" },
            { value: "landscape", label: "Landscape" },
            { value: "portrait", label: "Portrait" },
            { value: "square", label: "Square" },
          ]}
          onChange={setOrientation}
        />
        {providers.length > 1 && (
          <SelectField
            ariaLabel="Photo source"
            value={provider}
            options={providers.map((p) => ({ value: p, label: PROVIDERS[p].label }))}
            onChange={(p) => {
              setProvider(p);
              setProviderState(p);
            }}
          />
        )}
      </div>
      <button className="photo-sources-toggle" aria-expanded={sources} onClick={() => setSources(!sources)}>
        {sources ? "Hide sources and keys" : "Sources and keys"}
      </button>
      {sources && (
        <div className="photo-sources">
          <label className="photo-check">
            <input
              type="checkbox"
              checked={nc}
              onChange={(e) => {
                setNonCommercial(e.target.checked);
                setNc(e.target.checked);
              }}
            />
            <span>Include non-commercial licences</span>
          </label>
          <label className="photo-key">
            <span className="muted small">Pexels key (optional)</span>
            <input
              className="textinput"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste a key from pexels.com/api"
              aria-label="Pexels API key"
              value={pexelsKey}
              onChange={(e) => {
                setPexelsKey(e.target.value);
                setKey("pexels", e.target.value);
                if (!e.target.value.trim() && provider === "pexels") {
                  setProvider("openverse");
                  setProviderState("openverse");
                }
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </label>
          <p className="muted small">Openverse needs no key. Pexels has no safe-search switch (its library is curated). Keys stay in this browser and go only to api.pexels.com.</p>
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {live}
      </div>
      {!online && <div className="photo-note">Photo search needs the internet.</div>}
      {state.s === "loading" && results.length === 0 && (
        <div className="photo-grid skeleton" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
      {state.s === "empty" && <div className="photo-note">No photos for "{searched}".</div>}
      {err && (
        <div className="photo-note error" role="alert">
          {describe(err)} {hint}
          <button className="btn small" onClick={() => search(searched || query, pages.current)}>
            Retry
          </button>
        </div>
      )}
      {results.length > 0 && (
        <ul className="photo-grid" ref={grid} aria-label="Photo results">
          {results.map((r, i) => (
            <li key={r.id}>
              <button
                className={"photo-tile" + (busy === r.id ? " busy" : "")}
                tabIndex={i === focus ? 0 : -1}
                aria-label={label(r)}
                aria-busy={busy === r.id}
                title={`${r.title}\n${r.author} - ${r.license}${props.mode.kind === "panel" ? "\nClick to fill the selection, or place. Shift+Enter places a new layer. Drag onto the canvas." : ""}`}
                draggable={props.mode.kind === "panel"}
                onDragStart={(e) => e.dataTransfer.setData("application/x-designotron-photo", r.id)}
                onFocus={() => setFocus(i)}
                onClick={() => void choose(r, false)}
                onKeyDown={(e) => onKey(e, i, r)}
              >
                <img src={r.thumb} alt="" referrerPolicy="no-referrer" loading="lazy" draggable={false} />
                {r.nonCommercial && <span className="photo-badge">NC</span>}
                <span className="photo-meta">
                  <span className="photo-author">{r.author || "Unknown"}</span>
                  <span className="photo-license">{r.license}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.s === "ok" && state.hasMore && (
        <button className="btn block photo-more" onClick={loadMore}>
          Load more
        </button>
      )}
      {state.s === "loading" && results.length > 0 && <div className="muted small photo-note">Loading…</div>}
      <p className="muted small photo-credit">
        Photos from{" "}
        <a href={PROVIDERS[provider].site} target="_blank" rel="noopener noreferrer">
          {provider === "pexels" ? "Pexels" : "Openverse"}
        </a>
        . Credits are saved with each photo; check the licence before publishing.
      </p>
    </div>
  );
}

/** What went wrong, in words for the person. */
function describe(err: unknown): string {
  if (err instanceof PhotoError) {
    if (err.kind === "rateLimited") return err.extra.retryAfter ? `Too many searches. Try again in ${err.extra.retryAfter} s.` : "Too many searches right now. Wait a minute and try again.";
    if (err.kind === "offline") return "Photo search needs the internet.";
    return err.message;
  }
  return String(err instanceof Error ? err.message : err);
}

function short(s: string): string {
  return s.length > 40 ? s.slice(0, 39) + "…" : s;
}

function useOnline(): boolean {
  const [on, setOn] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return on;
}
