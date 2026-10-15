# Workbench 0.3.11 visual QA

Source: local approved prototype capture workbench-r22/prototype-wide.png (1120×800 pixels, CSS1120×800, DPR1).
Implementation: workbench-r22/ui/delivered-wide.png (2240×1600 pixels, CSS1120×800, DPR2), actual installed Electron0.3.11. Normalized implementation to1120×800 and composed beside source in workbench-r22/comparison.png; both opened together and inspected. Safe coastal media selected, paused at0, task detail at top, light theme. Source task order/counts are demo data; installed capture uses real isolated queue and actual export cancellation/output history, so these content differences are expected rather than measured as pixel drift.

Findings and iteration:
- P2: source CSS incorrectly hid real native video controls. Removed that selector; final delivered screenshot shows real seek, time, volume and fullscreen controls. Primary preview/export actions verified in both candidate and installed app.
- P2: dark primary theme selector had reversed scoping; fixed selector and recaptured after transition settles. delivered-760-dark.png shows readable warm primary, dark secondary/background, semantic status colors.
- No remaining actionable P0/P1/P2 visual mismatch in the checked Chinese workbench scope.

Required surfaces:
- Typography: same system/PingFang font family, hierarchy and comparable weights; heading/source alignment and long task truncation checked at1120 and760. New English workbench copy remains an explicit localization limitation outside this Chinese visual acceptance.
- Spacing: same240px sidebar at1120,54px titlebar, main padding and16:9 image composition. Native controls differ from demo control drawings for real keyboard/media operation. Editor uses real range inputs and numeric fields rather than fake thumbnail strips.760 has independent scrolling and no horizontal overflow.
- Tokens: original warm white/orange palette retained; dark green-gray palette and visible focus state checked. Task errors and missing file states separately exercised.
- Image fidelity: same supplied coastal sample/poster; no generated replacements; missing thumbnails use existing icon library rather than fake imagery. Native contained media preserves aspect ratio.
- Copy: real source hostname, timestamps, output filenames/paths, progress and errors; prototype-only demo chrome removed. Settings/add/history/queue remain real entry points.

Focused review: title/preview/action region and760 output list inspected in full-resolution screenshots; file names wrap and controls remain reachable. Native editor range2–8sec, JPG and audio actions, invalid range disabled, cancellation and restart verified. No claim of a fresh whole-app console-error audit or network/site acceptance.

Follow-up P3: closer icon silhouettes and a real thumbnail filmstrip can be iterated; the present range controls are functional. Platform codec support remains visible through fallback error/system open rather than an all-codec preview promise.

Implementation checklist: controls restored; theme corrected; actual outputs decoded; safe install and data integrity passed; final captures reviewed.

final result: passed
