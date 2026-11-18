# FitForge

Turn a phone photo + your measurements into a custom-fit, 3D-printable part (3MF / STL) for Bambu Studio and the H2D.

Runs entirely in the phone browser — no server, no account. Add it to your home screen for an app-like experience (works offline after the first load).

## Workflow

1. **📷 Photo** — Shoot straight down with the part (or a contour-gauge tracing) on white paper and a ruler lying flat at the same height. Or skip the photo and start from a rectangle.
2. **📏 Scale** — Tap two ruler marks (e.g. 0 and 100 mm), type the distance, **Set scale**. A magnifier shows while you drag handles.
3. **✏️ Shape**
   - **＋ Points**: tap corners in order; tap on an edge to insert a point.
   - **✨ Auto-trace**: tap the object and the outline is traced for you (adjust sensitivity if it grabs the background).
   - **✋ Edit**: drag points; pinch to zoom.
   - **Tap a corner** → enter a radius from your **radius gauge** (R0.5–R25 quick picks) or make it a smooth curve.
   - **Tap an edge label** → type the exact caliper length, or turn the edge into an arc (bulges out / curves in) using a radius-gauge value.
   - **Overall size** → stretch the shape to your exact caliper width × height.
4. **🧊 3D**
   - **Solid part**: thickness + fit clearance (shrinks the part to slide into an opening).
   - **Holder / pocket**: a block with a pocket of your shape (depth, floor, wall, clearance, outer shape).
   - **Test-fit slice**: exports a thin 1.6–2 mm version that prints in minutes so you can check the fit first.
   - **Export 3MF / STL** or **Share…** straight to another app.

## Accuracy tips

- Photo measurements are good for *shape* (≈ ±0.5 mm with a careful top-down shot). Type caliper numbers for the edges that matter.
- Use the longest ruler span you can when setting the scale.
- Print the test slice, adjust clearance by 0.1–0.2 mm, then print the real part.

## Roadmap

- Plain-language editing ("rectangle 80×40, 6 mm thick, two M3 holes 10 mm from the left") powered by Claude
- Tap-to-edit on the 3D model (holes, chamfers, slots, fillets on top edges)
- Perspective correction with a printable calibration card
- Multiple profiles (top + side view) combined into one part

## Tech

Vanilla JS modules, no build step. [Manifold](https://github.com/elalish/manifold) (WASM) for solid geometry, three.js for the 3D preview, fflate for 3MF zipping — all vendored in `vendor/`.
