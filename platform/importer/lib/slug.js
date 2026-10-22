// Slug function — copied verbatim from docs/CONTRACT.md §4 (both data and anatomy workstreams MUST use it).
export const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()
  .replace(/\(.*?\)/g,' ').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');

// Variant that KEEPS parenthesised content (used for protocol ids such as
// "Top 10 Inmunológico (inmunodeficiencia)" -> "inmunologico-inmunodeficiencia").
export const slugKeep = s => slug(String(s).replace(/[()]/g, ' '));
