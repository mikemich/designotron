// Whether the plugin in the editor has changes that Escape or Close would throw away.

export interface Draft {
  name: string;
  description: string;
  code: string;
  builtin?: boolean;
}

/** Unsaved changes: anything different from the saved plugin, or, for a new one (`saved` undefined),
 *  any name or description, or code other than the starting `template`. A built-in is read-only. */
export function pluginDirty(editing: Draft | null, saved: Draft | undefined, template: string): boolean {
  if (!editing || editing.builtin) return false;
  if (saved) return saved.name !== editing.name || saved.description !== editing.description || saved.code !== editing.code;
  return !!editing.name.trim() || !!editing.description.trim() || editing.code !== template;
}
