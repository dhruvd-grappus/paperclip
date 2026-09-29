/**
 * Re-exported from `@paperclipai/shared`: the same rule now runs on the server
 * (the Waiting On You endpoint builds its rows there), so the definition lives
 * next to the row builder that depends on it rather than in the UI.
 */
export {
  isVisibleTask,
  isVisibleWorkTask,
  visibleWorkTasks,
  type VisibilityFields,
} from "@paperclipai/shared";
