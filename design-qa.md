# Desktop navigation 0.3.13 visual QA

Scope: the user's requested modern desktop information architecture, with the accepted task/detail preview and new-download dialog retained. This is a deliberate redesign, not a pixel clone of the old duplicate-list screen.

Visual evidence: first captured and opened the real daily0.3.12 application, desktop-r24/before-current.png; after installation opened the real daily0.3.13 capture desktop-r24/after-current.png. Both are local-only personal screenshots. For the normalized management comparison, ran the preserved0.3.12 rollback with the same48 safe seeded tasks in an independent profile, captured desktop-r24/before-queue-1120.png. Final installed0.3.13 screenshot desktop-r24/ui/queue-wide.png uses the same data and1120×800CSS viewport. Both captures2240×1600px,DPR2, normalized to1120×800 and composed together in desktop-r24/comparison-queue.png; opened and reviewed together. Different per-profile display sort is intentional and not measured as content drift. No sensitive screenshot uploaded or committed.

Findings/iteration:
- P1 duplicate task lists and broad picture cards: removed the sidebar entirely for management/history/search, replaced queue cards with one compact list. Source/current comparison confirms each task appears once.
- P1 footer tool wall and competing top actions: moved task search/filter/sort above the list, grouped five stable global destinations in the window toolbar, one explicit New Download primary action, settings under labelled Downany application menu with Cmd+, retained.
- P2 old grid still restricted full-width management to a narrow column: initial screenshot rejected. Changed grid by scope, rebuilt, recaptured; final header/search/rows use available width at1120 and760.
- P2 closed dialog aria-modal blocked Cmd+F: narrowed modal guard, added test and reran native shortcut check.
- P2 Electron prompt would not support management rename: replaced with inline input; native save/restore passed.
- P3 disabled reorder clutter and stacked history actions: hid inactive reorder controls, moved collection actions into a compact menu and aligned history buttons; final screenshots inspected.

Required fidelity surfaces:
- Fonts/typography: same system/PingFang UI family,12px task row text,10–11px secondary metadata,24–26px management headings. Long titles truncate in rows; detail headings wrap. Historical raw status strings replaced with readable Chinese. Full English localization remains a documented follow-up.
- Spacing/layout:64px toolbar (56px in short windows), stable global navigation,280px task sidebar (240px at760),76px queue rows, consistent management padding.760×800 and760×600 verified in all four task/queue/collection/history states, light/dark. No horizontal overflow; persistent global actions remain visible.
- Colors/tokens: retained warm white/orange and dark green-gray palette from the approved workbench, consistent semantic states and selected/hover/focus cues; destructive record cleanup placed under maintenance and explicit confirmation.
- Images/assets: existing media imagery is retained for actual task preview; queue management uses the existing Icon library instead of decorative banner images. No fake thumbnails or generated visual replacements. Source/after safe queues share the same media fixture.
- Copy/content: named global destinations, scoped searches and selection counts, real backend status, explicit cleanup consequences and file preservation; no implementation/demo success text. Global cleanup says that it includes ended rows outside current filters. Labels/tooltips remain available when narrow layout hides decorative icons.

Focused evidence: app toolbar, queue selection/maintenance, confirmation and history action regions examined in full-resolution native screenshots; task preview/edit and new-download dialog checked independently. User's original actual screenshot and installed actual screenshot confirm the shipped application changed, rather than merely a mock.

Validation: candidate and installed each9native groups/23screenshots; real controlled queue pause/resume/reorder/confirmed record cleanup/history delete5groups and SHA checks; inline rename save/restore1group; new-download9groups; existing preview/crop/JPG/audio7groups; Desktop87files700tests; protocol4tests. No full accessibility or external-site quality claim.

Checklist: actual screen inspected before edits; single-list structure implemented; low-frequency settings separated; contextual actions and clear confirmation implemented; narrow/short themes and keyboard tested; rejected intermediate layouts recaptured; actual installed0.3.13/daily health/data integrity verified; old0.3.12 rollback retained.

final result: passed
