# New download dialog 0.3.12 design QA

Source truth: approved standalone prototype and NEW-DOWNLOAD-DESIGN.md. Captured local source new-download-r23/prototype-new-wide.png,1120×800 CSS/pixels,DPR1. Final candidate new-download-r23/ui-final/new-input-wide.png,1120×800CSS,2240×1600pixels,DPR2. Downsampled implementation to1120×800 and put both in one input new-download-r23/comparison-input.png. Focused header/input comparison new-download-r23/comparison-header-input.png. Both comparisons opened/reviewed; the same empty, light new-download state is compared. Underlying task content differs deliberately (real isolated queue vs prototype demo), so this QA judges dialog and overlay rather than claiming the background fixtures match.

Findings and repair history:
- P2: old workbench button specificity made close/paste/recovery buttons lose compact styles. Scoped new stylesheet beneath.workbench, recaptured final candidate and installed screenshots. Close and paste now match the source compact alignment and prominence.
- No remaining actionable P0/P1/P2 in the verified Chinese download flow. Legacy source demo links, example results and demo-only labels are intentionally removed; account scope and real errors replace demo controls.

Required surfaces:
- Typography: existing system/PingFang stack,21px title,12px labels,13px input and11px supporting copy maintain source hierarchy. Real media titles truncate within rows and path text can wrap. New English labels remain a documented localization limitation.
- Spacing/layout:600px centered dialog, original15px corners, header/body/footer padding and restrained overlay maintained.760×600 shows fixed accessible header/footer with independently scrolling body, no horizontal overflow. Explicit account settings replace the source sample row, preserving a similar initial height.
- Tokens: source warm-white/orange and green-gray dark palette, semantic warning/status colors and blue focus ring retained. Shallow control styles no longer inherit larger workbench dimensions.
- Images/assets: source empty state has no required media imagery. Results display actual parsed thumbnails only when available; missing metadata uses the existing Icon library, no fake sample media. Source and app use the same supplied workbench structure, no generated placeholders.
- Copy/content: real parse progress, partial failures, task addition and permission handling; no simulation success, no automatic account switch. Format list follows actual backend capabilities. Webpage recognition explicitly uses the existing real separate native window. No promise of M4A/WebM or standalone cover saving without backend support.

Interaction evidence: source first native pass; final candidate8groups plus real YouTube download; installed10groups plus real YouTube download. Enter parses, Tab remains within dialog, Escape/explicit cancel prevent late creation, close/reopen keeps draft/results, duplicate clicks add once, failed links retry without readding successes, directory/format/naming persist on created tasks after restart. Existing media preview/export7group candidate regression passed. IME guard is synthetic-event tested, not actual human composition. No new full-app console-zero claim.

Final evidence: ui-final/new-input-wide.png; ui-installed/new-ready-760-short-light.png and dark.png; candidate-results.json; installed-results.json; options-persistence.json; media-regression.json. Actual installed0.3.12 matches candidate core hashes and preserves daily data.

Follow-up P3: finer icon silhouette matching; full English localization. Downloaded-task persistence is verified; the draft intentionally remains current-session memory only.

Implementation checklist: source read and captured; real capabilities wired; specificity fixed and recaptured; same viewport full/focused comparison reviewed; short/narrow themes and key flows tested; no destructive data or sensitive-setting change.

final result: passed
