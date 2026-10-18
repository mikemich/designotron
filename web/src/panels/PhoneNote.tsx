import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { setTool } from "../store";

const KEY = "dt:phone-note";
export const isPhone = () => window.matchMedia("(max-width: 820px)").matches;

/** On phones: start with the hand tool and say what works here. */
export function PhoneNote() {
  const [show, setShow] = useState(() => {
    try {
      return isPhone() && localStorage.getItem(KEY) !== "1";
    } catch {
      return isPhone();
    }
  });
  useEffect(() => {
    if (isPhone()) setTool("hand");
  }, []);
  if (!show) return null;
  const hide = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
  };
  return (
    <div className="phone-note" role="status">
      <span>
        Designotron is best on a computer. On a phone you can look around (drag, pinch to zoom), leave comments, present prototypes and ask Claude.
      </span>
      <button className="ibtn" title="Hide" onClick={hide}>
        <X size={13} />
      </button>
    </div>
  );
}
