const shown = (groups, channels) => `c.direction IN ('in','out') AND c.session_group NOT IN (${groups})
  AND c.channel <> '' AND c.channel NOT IN (${channels})`;
// Lists and summaries never include internal messages; message pages do.
// The `origin` group is shown only through the Origin conversation's range.
export const visible = shown("'origin','*'", "'void','internal','system','scheduler','control'");
export const messageVisible = shown("'origin','*'", "'void','system','scheduler','control'");
export const originVisible = shown("'*'", "'void','internal','system','scheduler','control'");
export const originMessageVisible = shown("'*'", "'void','system','scheduler','control'");
