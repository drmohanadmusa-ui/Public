---
name: design-md-library
description: A local library of 80+ DESIGN.md files (colour tokens, type scales, spacing, components, tone) analysed from well-known product websites such as Linear, Stripe, Vercel, Notion, Wise and Revolut. Use when the user asks for a page or app to "look like" or "feel like" a named product, asks for a design-system starting point, or wants style references before a redesign.
---

# DESIGN.md library

The collection from github.com/VoltAgent/awesome-design-md is cloned by the cloud setup script to:

```
~/.claude/design-md-library/design-md/<site>/DESIGN.md
```

List what is available with `ls ~/.claude/design-md-library/design-md`. If the folder is missing (a local machine, or the setup script failed), clone it:

```bash
git clone --depth 1 https://github.com/VoltAgent/awesome-design-md ~/.claude/design-md-library
```

## How to use it

1. Pick the one or two files closest to what the user asked for and read them in full.
2. Take the **system**: palette roles, type scale, spacing rhythm, radius, density, motion, tone of copy. Write the chosen values into the project's own `DESIGN.md` (or CSS variables) so later work stays consistent.
3. Adapt it to the project's content and existing components; do not restructure a working app to match another site's page layout.
4. Pair it with the design skills (Hallmark, Impeccable, taste) for build and review.

## Limits

- These files describe other companies' brands. Use them for direction and tokens, never to reproduce a company's logo, name, wordmark, illustrations or a page that could pass for theirs.
- Check contrast and accessibility of borrowed colours in the user's actual context; a palette that works on a marketing site may fail on a dense data screen.
