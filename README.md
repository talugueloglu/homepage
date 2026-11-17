# Talu Güloğlu — homepage

A static site: upload the contents of this folder to any static host
(GitHub Pages, Netlify, Cloudflare Pages, or your own server). There is
no build step.

- `index.html`: the page and its metadata (title, link previews, search data)
- `tissue.js`: the animated stippled tissue behind the text (WebGL2, with a
  still-image fallback; a still image for visitors who prefer reduced motion)
  Each visit grows one of six tissues (airway lining, gut lining, fat tissue,
  nerve ganglion, bone marrow, inflamed lining), never the same one twice in a
  row. A capillary runs through each, with red blood cells in single file.
  Clicking an ordinary cell makes it divide. To link to one tissue, add `?tissue=` and one
  of `airway`, `gut`, `fat`, `nerve`, `marrow`, `inflamed`. The recipes are the
  `TISSUES` table near the top of the file.
- `tissue.css`: styles, including light and dark mode
- `effects.js`: the DNA letter effect on hover
- `navigation.js`: switches About, Writing and articles in place, with the
  tissue reshaping or regrowing around the new text; direct links and back/forward still work
- `blogs/index.html`: the Writing page (says "Coming soon" until there are posts;
  the styles for post cards and articles are still in `tissue.css`)
- `talu-gueloglu-cv.pdf`: the CV linked from the top of each page
- `portrait-256.webp`, `portrait-256.jpg`, `favicon.svg`: images

To preview locally, serve the folder rather than opening the file directly,
for example: `python3 -m http.server` and then visit http://localhost:8000.

When you change a script or the stylesheet, bump its `?v=` number in
`index.html` so returning visitors get the new version.
