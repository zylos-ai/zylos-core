# Dashboard Visual Design Specification

Scope: Dashboard pages, detail drawers, rich conversation content, light and dark themes, and desktop and mobile interfaces.

[Approved] Howard has approved the following 22 design decisions as the basis for subsequent implementation and review. This revision updates the specification only; it does not mean the product migration is complete. Subsequent height changes adjust only height and alignment, preserving the approved segmented-control colors and existing interactions.

[Current] Styles are based on `8c08d822`. The sections below record maintainable tokens and control families. The complete value snapshot in the PR #1254 description is baseline evidence and is not copied into this specification for every visual change.

[Approved] Rule status meanings: **[Current]** describes the interface at the value baseline; **[Approved]** identifies implementation and review requirements. Decision-number references follow the decision list. Historical values do not represent approved targets. All relative source links start from this file's directory; variable names help developers locate code, while the interface uses plain language.

## Decision List

[Approved] All 22 items follow Howard's reply in TG topic 16 msg 659. The scope of decision 4 also follows option B in msg 677 and the composer exception confirmed in msg 736. The table records approved requirements and migration effects. The originally proposed mobile sizes in decisions 3,4 have been changed to 36 px per the reply, and decision 13 again includes negative margins that extend mobile touch targets.

| Decision | Subject | Historical values and page examples | Approved requirement | Effects and tradeoffs | Status / evidence |
|---|---|---|---|---|---|
| 1 | Regular desktop toolbar height | Usage switches and dates 32 px, Apply 30 px; settings inputs and buttons 32 px | Standardize on 30 px; measure segmented controls as the entire outer track at 30 px | Usage, settings, scheduled-task filters, and chat headers become more compact; existing 32/34 px values in regular toolbars require migration; large forms follow approved decision 3 | Approved (TG topic 16 msg 659) |
| 2 | Compact desktop toolbar height | Overview search 26 px, short segmented outer track 22 px; small buttons and filter chips 26 px | Standardize on 26 px, including desktop Overview | Overview segmented controls grow by 4 px; small icon actions match their toolbar, without enlarging every small graphic | Approved (TG topic 16 msg 659) |
| 3 | Large form height | Scheduled-task fields 34 px; conversation question fields and submit buttons 36 px on desktop, 40 px on mobile | Large fields and same-row buttons are 36 px on both desktop and mobile | Scheduled-task forms become taller; mobile question fields and submit buttons shrink from 40 px to 36 px, while textareas continue growing with content | Approved (TG topic 16 msg 659) |
| 4 | Minimum ordinary mobile interaction target | Most workbench controls have a 40 px minimum, settings navigation and top-bar icons 44 px; Overview search outer frame remains 26 px | Ordinary single-line interaction frames have a 36 px minimum; standardize ordinary mobile single-line controls on 36 px; navigation elements such as settings navigation and top-bar icons remain 44 px | Ordinary mobile single-line controls (including search, filters, and buttons) become 36 px; mobile composer input, attachment, and send buttons retain current sizes as an exception (msg 736); navigation retains its own dimensions and multiline options are not compressed | Approved (TG topic 16 msg 659; msg 677 option B; msg 736 composer exception) |
| 5 | Passive status pill height | Runtime pill minimum 24 px, connection pill 28 px, question status 24 px | Standardize passive pills on 24 px | Top-bar connection status becomes slightly more compact; clickable pills still follow their row and mobile touch-target tier | Approved (TG topic 16 msg 659) |
| 6 | Control corner radius | Buttons and fields commonly 8 px; pricing inputs 6 px, conversation lists 9 px, local controls 7/10/11 px | Standardize single-line buttons, fields, and selectable list rows on 8 px | Settings, conversation lists, and local inputs gain consistent outlines; graphics and badges do not use this tier | Approved (TG topic 16 msg 659) |
| 7 | Bottom-sheet top corners | Mobile More menu 16 px, local conversation sheets 14 px | Standardize bottom-sheet top corners on 16 px | Local conversation sheets become slightly rounder; other overlays retain their own family rules | Approved (TG topic 16 msg 659) |
| 8 | Fully rounded component radius | Chip 13 px, pill 20 px, connection pill 999 px, dots 50% | Standardize capsules on 999 px; circles remain 50% | Remain fully rounded after height changes; avoid fixed 13/20 px radii becoming mismatched with height | Approved (TG topic 16 msg 659) |
| 9 | Message composer container radius | Desktop composer 11 px; mobile input 22 px, send button fully rounded | Change desktop container to 12 px; mobile input remains 22 px | Slightly refine the desktop outline, preserving the mobile input's capsule appearance | Approved (TG topic 16 msg 659) |
| 10 | Ordinary surface shadows | Base-card blur 42 px in light theme, 26 px in dark; rich-content cards use short shadows and fine outlines, with separate button shadows | Give cards the same short shadow and fine outline as rich conversation content; buttons and selected blocks retain their own light shadows | Memory and base cards become lighter; buttons and selected blocks remain distinct rather than sharing one shadow | Approved (TG topic 16 msg 659) |
| 11 | Overlay shadows | Drawers inherit the theme's large shadow; local popups hard-code blur values such as 16/32 px | Drawers and popups share the same soft large shadow, retaining the current effect for each light and dark theme | Local popup shadows change; focus rings and selection side lines are not overlay shadows | Approved (TG topic 16 msg 659) |
| 12 | Main spacing tiers | Root spacing 4/8/16/24/32 px; rich-content card padding 20 px desktop, 16 px mobile; form row spacing 14 px | Use main tiers 4/8/12/16/20/24/32 px | Move general spacing such as 14/18/22/28 px in forms to the nearest suitable tier; do not mechanically round safe-area or chart values | Approved (TG topic 16 msg 659) |
| 13 | Micro spacing and compensation | Segmented padding 2 px, icon/text gaps commonly 3/5/6/7 px; negative margins extend mobile touch targets and center graphics | Consolidate icon/text gaps into 2 px and 6 px tiers; retain 1 px adjustments for graphic alignment; retain negative margins that enlarge mobile hit areas | Small actions become more consistent; retain precise values such as 1 px for decorative graphics, negative mobile touch-extension margins, and safe-area formulas | Approved (TG topic 16 msg 659) |
| 14 | Font-size tiers | Headings 15/17/19/20 px; body 13/14 px; descriptions 11.5/12 px; tiny badges 9–10.5 px | Headings 16/18/20 px, body 13/14 px, controls 12/12.5 px, descriptions 11/12 px; mobile inputs retain 16 px | Consolidate heading and description sizes; chart ticks and tiny badges retain their dedicated sizes without enlargement | Approved (TG topic 16 msg 659) |
| 15 | Line-height tiers | Root is 1.5 times font size; conversation body 24 px, field descriptions 18 px, labels 20 px; local values range 1–1.8 times | Retain root 1.5; body 14/24 px, descriptions 12/18 px, labels 13/20 px; vertically center single-line controls | Consolidate multiline content into the three combinations; graphics, chart ticks, and dedicated badges retain their own line heights | Approved (TG topic 16 msg 659) |
| 16 | Panel-layer colors | Base cards use translucent white; workbench panels are solid; conversations have sunken and raised selected surfaces | Ordinary panels adopt the same hierarchy as rich conversation content: flat panels, sunken inputs, raised selected blocks | Unify ordinary panel layers; retain transparent navigation backgrounds, code backgrounds, and dedicated internal-forwarded-message colors | Approved (TG topic 16 msg 659) |
| 17 | Secondary description text color | Base descriptions commonly use gray `--text-muted`; rich-form descriptions use darker `--c-ink-meta` | Make body descriptions one gray tier darker for readability in light theme; decorative ticks retain their colors | Improve light-theme descriptions without simultaneously recoloring body or emphasized text | Approved (TG topic 16 msg 659) |
| 18 | Primary and destructive action colors | Workbench and questions already share primary, danger, and hover/pressed colors; old local rules still contain fixed colors | Standardize primary actions on deep teal in light theme and bright teal in dark theme, destructive actions on red; retain corresponding hover and pressed brightness changes | Remove duplicate local values while preserving existing light-theme deep teal, dark-theme bright teal, and danger red | Approved (TG topic 16 msg 659) |
| 19 | Disabled appearance | Ordinary button opacity 0.5, icons 0.38, question buttons 0.45, options 0.55; fields include an opaque dashed exception | Standardize buttons and options on 0.5; input text remains opaque, with sunken backgrounds and muted text | Disabled icons become clearer; preserve readable field values, and do not express every disabled state solely through reduced opacity | Approved (TG topic 16 msg 659) |
| 20 | External button focus | Workbench uses a 2 px outline with 2 px offset; question buttons use a double ring | External buttons use two focus rings: the inner ring separates button and outer ring, and the outer ring uses the accent color | Bring keyboard focus treatments closer across both button families; dark and destructive buttons retain semantic colors | Approved (TG topic 16 msg 659) |
| 21 | Input focus | Workbench uses a 2 px outline; rich forms and mobile composer use a 3 px ring | Focused inputs use a 3 px outer ring, normally accent-colored and red on error | Change search, date, and ordinary input focus; retain danger-colored rings for invalid fields | Approved (TG topic 16 msg 659) |
| 22 | Loading-copy punctuation | Both “…” and “...” ellipses exist; error descriptions vary in length | Standardize Chinese loading text on “…”; retain “...” in English; errors state the outcome before the action | Migrate only in PRs authorized to change copy, preserving interpolation and action conditions | Approved (TG topic 16 msg 659) |

## 1. Design Tokens: Consistent Appearance for Shared Purposes

[Current] Page backgrounds, panels, sunken surfaces, and selected surfaces serve different layers. Light theme primarily distinguishes layers through pale backgrounds and borders; dark theme uses surface brightness. Simply replacing light-theme white backgrounds with black is insufficient.

[Approved → decisions 16,17,18] Migrate surfaces, description text, and action colors according to decisions 16,17,18. Runtime states and chart series retain their respective business mappings; other current theme values remain unchanged. Consult the value snapshot and source for complete local colors and formulas; identical color declarations do not necessarily serve the same purpose.

### 1.1 Theme Table

[Current] Each row below represents a purpose; the two value columns show current light and dark theme values, not new colors introduced by this revision.

| Purpose / variable | Light | Dark |
|---|---|---|
| Page `--bg` | `#f7faf9` | `#11171d` |
| Secondary layer `--bg-secondary` | `rgba(255,255,255,.76)` | `#19222b` |
| Base card `--bg-card` | `rgba(255,255,255,.88)` | `#19222b` |
| Elevated panel `--bg-elevated` | `#ffffff` | `#202c37` |
| Code background `--bg-code` | `rgba(241,245,249,.9)` | `#15202b` |
| Body text `--text` | `#101827` | `#e6edf3` |
| Secondary text `--text-dim` | `#526170` | `#b1bfcc` |
| Muted text `--text-muted` | `#7a8794` | `#93a4b5` |
| Accent `--accent` | `#0d9488` | `#43c7b5` |
| Accent hover `--accent-hover` | `#0f766e` | `#6cddcd` |
| Pale accent background `--accent-dim` | `#ccfbf1` | `#173e3b` |
| Purple / green `--purple/green` | `#6366f1` / `#059669` | `#b0a5ff` / `#50c996` |
| Border `--border` | `rgba(15,118,110,.16)` | `#334656` |
| Focus `--border-focus` | `rgba(14,165,163,.45)` | `#43c7b5` |
| Navigation background `--nav-bg` | `rgba(255,255,255,.82)` | `#19222b` |
| Offline / idle | `#64748b` / `#16a34a` | `#8b99a8` / `#50c996` |
| Busy / waiting | `#a16207` / `#2563eb` | `#e9ba62` / `#70a9ff` |
| Possibly stuck / stuck / unknown | `#ea580c` / `#dc2626` / `#6b7280` | `#f8a369` / `#f77c87` / `#9ba7b4` |

[Current] Workbench runtime colors are separately working `#1b9d75`, idle `#82b9ac`, waiting `#d69b35`, and error `#db5252`. Usage chart series use `#0d9488/#6366f1/#d97706`; conversation chart series use `#35a998/#e1a33d/#4f8cf7/#e06b83/#aa79e8/#73859f`. Quota bars change color continuously with the remaining proportion and must not become fixed success/failure colors.

### 1.2 Token and Formula Maintenance References

[Current] When modifying a family, update only the table below and the approved decisions. Linked sources govern exact color mixing, theme overrides, and dedicated values, avoiding duplicate documentation of every CSS declaration.

| Purpose | Current token / core value | Exact source |
|---|---|---|
| Panels, subtle borders, hover backgrounds | `--wb-panel/line/line-strong/hover` | [wb.css lines 4–11](../public/css/wb.css) |
| Sunken, selected, and input surfaces | `--c-surface/sunken/raised/input-bg` | [wb.css lines 44–57,102–113](../public/css/wb.css) |
| Primary/destructive actions, soft status backgrounds, description text | `--c-primary/danger/on-fill/ink-meta` and related tokens | [wb.css lines 59–80,96–124](../public/css/wb.css) |
| Card, button, filled-button, selected-block shadows | `--c-shadow-card/btn/fill/thumb/xs` | [wb.css lines 80–88,124–130](../public/css/wb.css) |
| Base and overlay shadows | `--shadow-card`, `--shadow-card-hover`; light blur 42/52 px, dark 26/32 px | [Light theme](../public/themes/light.css), [dark theme](../public/themes/dark.css) |
| Main radii and spacing | Radii 12/8/4 px; spacing 4/8/16/24/32 px | [style.css lines 10–18](../public/css/style.css) |
| Rich-content radii and padding | Radii 6/8/12 px; padding 20 px desktop, 16 px mobile | [wb.css lines 35–42](../public/css/wb.css), [conversation.css line 1448](../public/css/conversation.css) |
| Charts and quota bars | Series, axes, tooltips, and continuous-color formulas | [Usage](../public/js/wb/usage.js), [conversation charts](../public/js/wb/conversation-charts.js), [quota](../public/js/wb/instance-strip.js) |

[Approved → decisions 6,7,8,9,10,11,12,13] Migrate affected control, bottom-sheet, capsule, and input-container radii, shadows, and spacing according to the approved decisions. Retain 1 px graphic-alignment adjustments and negative margins enlarging mobile hit areas. Card radius 12 px and segmented inner blocks at track radius minus 2 px are current values and remain. Selection side lines and focus rings retain their semantics and must not be bulk-replaced as ordinary shadows.

### 1.3 Fonts and Typography

[Current] Body text uses the local Inter variable font, with Chinese falling back through system Chinese fonts. Monospaced content uses JetBrains Mono, falling back to system monospace when absent. [Font declarations](../public/css/style.css) and [font references](../public/index.html) are the maintenance entry points.

| Item | Current values and complete variants | Status / decision |
|---|---|---|
| Font size | 9/9.5/10/10.5/11/11.5/12/12.5/13/13.5/14/14.5/15/16/17/18/19/20 px; also 0.92 em, inherited sizes, and 0 for hiding | [Approved → decision 14] |
| Font weight | Body 400, currently 450/500/550/600/650/700; font files support 100–900 | [Current] |
| Line height | 1/1.2/1.3/1.35/1.4/1.45/1.5/1.55/1.6/1.65/1.7/1.8 times; fixed 15/16/18/20/22/24 px | [Approved → decision 15] |

[Current] See the complete value snapshot for long-tail radii, shadows, borders, spacing, and icon overrides. Geometry, column widths, safe areas, and chart-specific values are outside bulk font-size or spacing-tier migrations.

## 2. Control Dimensions and Same-Row Alignment

[Approved] Buttons, inputs, search, dropdowns, dates, and segmented controls on the same row use the same height tier and are vertically centered. Compare the segmented control's **outer track** with other controls' outer frames; the inner selected block is inset by the padding. Heights within each row must be equal, with vertical centerline deviation no greater than 1 px.

[Current] Desktop Overview search is 26 px high and the segmented outer track is 22 px, both centered at 146.5 px: sharing a centerline does not make their heights equal. The Usage row has 32 px range and date controls and a 30 px Apply button; the chat sidebar has a 34 px track and 28 px Refresh button. Check heights and centerlines separately in these cases too.

[Current] The historical columns below record the final effective dimensions in the baseline version. Later styles may override earlier declarations; one variable does not prove site-wide consistency. The convergence column contains approved targets; historical values are not exceptions.

| Family | Historical desktop values | Historical mobile values | Convergence requirements |
|---|---|---|---|
| Ordinary, primary, destructive buttons | Regular 30 px, small 26 px, settings 32 px | Many workbench controls have a 40 px minimum | [Approved → decisions 1,2,4] Desktop regular 30 px, compact 26 px; standardize ordinary mobile single-line interaction frames on 36 px |
| Inputs, search, dropdowns, dates | Inputs 28 px; Overview search 26 px; dropdowns and dates commonly 32 px | Some have a 40 px minimum; Overview search outer frame remains 26 px | [Approved → decisions 1,2,4] Desktop regular 30 px, compact 26 px; standardize ordinary mobile single-line interaction frames on 36 px |
| Segmented controls | Regular track 32 px, compact track 22 px, chat-list track 34 px | Tracks commonly 44 px; two-line engine selection can grow automatically | [Approved → decisions 1,2,4] Desktop regular 30 px, compact 26 px; standardize ordinary mobile single-line interaction frames on 36 px |
| Large fields, question submit buttons | Scheduled-task fields 34 px; question family `--c-h` is 36 px | **Question family `--c-h` is 40 px**; field font size 16 px | [Approved → decision 3] Large fields and same-row buttons are 36 px on desktop and mobile; mobile question fields and submit buttons shrink from 40 px to 36 px |
| Multiline inputs | Task description minimum 120 px; question textarea minimum 88 px | Grow with content and dedicated rules | [Current] Single-line heights do not apply |
| Message composer and send | **Final effective height 40 px**, overriding the earlier 30 px | **Final effective height 44 px**; attachment width 40 px, send 44 × 44 px | [Current] Separate from the question `--c-h` family; decision 04 exception (msg 736): mobile message input, attachment button, and send button retain current sizes |
| Icon buttons, links | Icons 30 × 30 px, small 24 × 24 px, top bar 32 × 32 px; Refresh 26 × 28 px; links follow content | Existing mobile targets 40/44 px | [Approved → decisions 1,2,4] Desktop actions follow their row at 30/26 px; ordinary mobile single-line interaction frames 36 px, top-bar navigation icons remain 44 px |
| Chip, tag, pill | Chip 26 px; tag outer frame 20 px (retained); pill minimum 24 px, connection pill 28 px | Interactive chips follow mobile touch-target tiers; passive status is not treated as a button | [Approved → decisions 2,4,5] Desktop interactive chips 26 px, ordinary mobile single-line interaction frames 36 px; passive pills 24 px, tags retain current sizes |
| Switches, check controls | Switches 36 × 20 px, micro switches 22 × 12 px, check controls 16 × 16 px | More-menu switches 40 × 24 px; question options minimum 48 px | [Current] |
| Navigation, multiline lists | Top bar 48 px, tabs 30 px, settings navigation 34 px, conversation list minimum 58 px | Top bar 52 px, bottom navigation 56 px, settings navigation minimum 44 px, menu items minimum 52 px | [Approved → decision 4] Mobile navigation elements such as settings navigation and top-bar icons remain 44 px; multiline options are not compressed; adjust other navigation only for same-row misalignment |

[Current] Dimension references: [workbench controls and search](../public/css/wb.css) lines 141–179,303; [question fields](../public/css/conversation.css) lines 1288–1310,1448; [final composer overrides](../public/css/conversation.css) lines 824,1704–1709.

[Approved] When top navigation and detail tabs already occupy separate rows, adjust them only if they are misaligned with other controls on their row. After wrapping, check each actual row separately; do not offset individual controls to compensate for a particular language.

## 3. Control Families and Interaction States

[Current] Ordinary, primary, and destructive buttons each have default, hover, and pressed appearances. Selected, keyboard focus, disabled, and loading are distinct states; do not describe unimplemented states as existing component capabilities.

| Family | Current default, hover, pressed, and selected states | Current focus, disabled, and loading states |
|---|---|---|
| Secondary / icon / link buttons | Ordinary buttons have panel backgrounds and borders; hover uses a pale background, darkens icons, and underlines links | Shared outline focus; disabled opacities respectively 0.5/0.38, links become muted; no unified spinner component |
| Primary / destructive buttons | Use their respective semantic colors, with corresponding darker/brighter hover and pressed colors | Workbench and questions have two focus treatments; question disabled opacity 0.45; existing submission flows disable controls while submitting |
| Inputs / dropdowns / dates / search | Panel backgrounds in light theme, recessed rich-form backgrounds in dark; rich-form borders darken on hover and use danger color on error | Workbench outlines and rich-form rings coexist; disabled fields retain readable values; loading hints are usually adjacent |
| Segmented controls | Recessed track, transparent unselected options; pale hover background; raised selected option with a light shadow and heavier text | 2 px inner focus; disabled opacity 0.5; no shared loading state |
| Chip / question options | Selected filter chips use a pale accent background; question options have hover, pressed, and selected borders and backgrounds | Question focus follows native check controls; disabled options 0.55, check controls 0.5; loading is handled by the owning submission flow |
| Tag / pill | Tags are compact metadata; runtime pills combine dots, hollow or dashed styles with text; connection pills distinguish live, degraded, polling, and reconnecting | Passive labels have no interaction focus or loading state; clickable pills behave as actual buttons; reconnecting dots pulse |
| Switches | Gray track means off, accent means on; thumb moves; hovering the sound switch does not change its on/off meaning | Keyboard focus exists; disabled and loading appearances are not fully unified and must not be claimed as fully covered |

[Approved] Segmented controls retain the established colors: recessed track, raised selected surface, light shadow, and normal/selected font weights 500/600. Do not restore a solid accent-colored selected background. [Shared rules](../public/css/wb.css) lines 1597–1633 define the colors; geometry follows section 2.

[Current] Check controls are 16 × 16 px, with 4 px checkbox corners and fully round radio buttons; selected marks use icon masks. Conversation activity uses a 13 px spinner and three 4 px thinking dots; working-status dots have a breathing animation. Corresponding rules already disable these effects for reduced motion.

[Approved → decisions 19,20,21] Migrate disabled opacity, button focus, and input focus according to decisions 19,20,21; retain current segmented focus and loading treatments. Interaction-state source references: [workbench](../public/css/wb.css), [question controls](../public/css/conversation.css), [question submission](../public/js/wb/chat-questions.js).

## 4. Icons: One Set and Clear Click Targets

[Approved] Navigation, actions, and states use the same icon set; do not use emoji as UI icons. Emoji in message bodies are outside the scope of UI icon replacement.

[Current] The [local icon set](../public/css/wb-icons.css) uses SVG masks with Lucide geometry, a 24 × 24 drawing coordinate system, round caps and joins, and the surrounding text color. No new icon package is loaded at runtime. [Icon helpers](../public/js/wb/plain-text.js) use this same set.

[Current] Regular stroke width is 1.75; small checkmarks use 2.5. The old SVG with stroke width 2 in the sound switch is currently hidden. Measure visible icons and transparent hit areas separately; icon size alone does not determine mobile touch usability.

[Current] Retain current visible icon sizes: regular 16 px, small 13 px, arrows 12 px, input actions 18 px, menus 20 px, mobile navigation 22 px. Retain the checkmark stroke-width exception as well. Icon-only actions retain accessible names; decorative icons are hidden from assistive reading. Selected states must use more than color alone.

## 5. Layout: Readable Content and Discoverable Actions

[Current] The workbench consists of a top bar, instance status, notices, main content, and right-hand details. The top bar is usually 48 px; navigation moves to a new row when space is insufficient. The scheduled-task drawer is 480 px wide and positioned according to the actual top-bar height. Settings has separate navigation and content areas.

[Current] The memory browser has file-tree and content columns, with a base file-tree width of 220–300 px. The conversation sidebar is 320 px wide with a 260 px minimum; rich-content cards have a 720 px maximum width. Old top-bar spacing in root styles does not represent the final workbench layout; include later-loaded styles when checking the actual result.

[Current] Cards and tables distinguish hierarchy through heading rows, borders, and whitespace. Empty states, errors, and loading hints belong in their page's content area; see section 7 for copy and section 3 for loading appearance.

## 6. Responsive Layout: Tasks Remain Usable on 390 px Mobile Screens

[Approved] The 390 px mobile interface must not have unintended overflow, clipped text, or obscured actions. Check touch targets separately from visible graphics; wrapped toolbars must still satisfy same-row height and centerline requirements.

[Current] Mobile uses bottom navigation, a More menu, and a settings drawer for secondary entry points. The settings drawer is no wider than 300 px or 84% of the screen width. Conversation focus mode hides the workbench top bar and bottom navigation; the message input area handles safe areas and keyboard space separately.

[Approved → decisions 3,4,13] Ordinary mobile single-line controls (buttons, inputs, search, dropdowns, dates, segmented outer tracks, interactive chips, and icon actions) have a minimum interaction frame of 36 px and are standardized on 36 px; large fields and same-row submit buttons are also 36 px. Navigation elements such as settings navigation and top-bar icons remain 44 px. Mobile composer is the decision 04 exception (msg 736): retain the 44 px-high message input, 40 × 44 px attachment button, and circular 44 × 44 px send button. Do not compress multiline options; textareas continue growing with content. Retain negative margins that enlarge mobile hit areas; preserve existing page behavior for wrapping and grouping entry points.

[Current] Dedicated layout references: [mobile navigation](../public/js/wb/mobile-navigation.js), [workbench media queries](../public/css/wb.css), [conversation media queries](../public/css/conversation.css). For fixed input areas, also check safe areas, visible height, back actions, and keyboard opening. Intentional internal scrolling in charts or tables must stay within their containers.

## 7. Copy: Preserve Factual Distinctions Without Exposing Development Processes

[Approved] User-facing interfaces use understandable status words and do not show development-plan numbers or internal jargon. Visual consistency must not alter delivery or execution facts; error codes must not be the only explanation.

[Current] Copy comes from [general Chinese](../public/i18n/zh.json), [workbench Chinese](../public/i18n/wb.zh.json), and the corresponding [general English](../public/i18n/en.json) and [workbench English](../public/i18n/wb.en.json). Preserve the business distinctions below; layout must not remove interpolation, counts, or actually available actions.

| Category | Current actual copy and distinctions to preserve |
|---|---|
| Connection | “实时 / 降级 / 轮询 / 重连中”; conversations separately use “实时更新已连接 / 实时更新未连接 · 轮询中”; these do not imply that work is in progress |
| Runtime | “忙碌 / 空闲 / 等待 / 启动中 / 未运行 / 运行中 / 未知 / 异常”; the legend uses “空闲（运行中）” |
| Login | “未登录 / 状态未知 / 已登录”; do not label every logged-out state as offline |
| Work display | “正在工作”; scheduled tasks use “正在执行定时任务” on desktop and “定时任务” on mobile; preserve background subtask counts |
| Delivery stage | “已入库 · 待投递 / 已入库 · 投递中 / 已投递到运行会话 / 已入库”; stored does not mean delivered, and delivered does not mean task complete |
| Failure and verification | “已入库 · 投递失败，不会自动重发”“已入库 · 认证拒收，不能重发”“状态待核对 · 请先核对再决定重试”“未入库 · 已保留输入”; short and full versions are not mechanically interchangeable |
| Scheduled tasks | Distinguish task status “已失效” from delivery result “送达失败”; do not group them as the same failure |
| Empty and unknown | “选择一个记忆文件查看内容。”“本机还没有定时任务”“没有符合筛选的事件”“暂无对话” are distinct empty states; unknown usage must not display as 0 |
| Actions | “刷新”“核对投递状态”“刷新状态”“刷新记忆目录”“应用” describe different actions; do not replace them with one word to achieve equal widths |

[Current] Runtime, connection, login, and delivery use distinct business copy; preserve the distinctions above.

[Approved → decision 22] Standardize Chinese loading copy on “…”; retain “...” in English. Errors state the outcome before the action. Migrate only in PRs authorized to change copy, preserving interpolation and action conditions.

## 8. Review Checklist and Browser Gates

[Approved] Read this document before every visual change, check delivery against all eight sections, and update affected rules. The approved requirements in the decision list govern the 22 decisions; historical values help locate migrations. Documentation-only changes do not introduce product mechanisms or site-wide tests.

### 8.1 Self-Review of All Affected Visual Areas

- [ ] [Approved] Identify the rules for colors, radii, shadows, spacing, fonts, dimensions, states, icons, layout, responsiveness, and copy individually; changes match approved values, with a clear purpose for each exception.
- [ ] [Approved] Record the page, row, controls, outer-frame heights, and centerlines for every actual row of mixed controls; outer-frame heights within each row are equal, centerline deviation ≤ 1 px, and segmented comparisons use the outer track rather than only the inner buttons.
- [ ] [Approved] Provide static screenshots for each changed page at 1280/390 px × light/dark, without hover or focus; cover the pages, tabs, menus, and drawers actually changed, and put images and measurement tables in the PR description.
- [ ] [Approved] Check actual hover, keyboard focus, selected, disabled, loading, and error states by family; mark families without the relevant capability as not applicable. Static styles alone do not prove interactions pass.
- [ ] [Approved] At 390 px, verify no unintended horizontal scrolling, text clipping, or obscured buttons; menus open and close, and keyboard focus is visible. Record graphic dimensions and hit areas separately. Ordinary mobile single-line interaction frames are 36 px; large fields and same-row buttons are 36 px on desktop and mobile. Mobile navigation elements such as settings navigation and top-bar icons remain 44 px. Under the decision 04 exception (msg 736), mobile composer retains a 44 px-high input, 40 × 44 px attachment button, and circular 44 × 44 px send button. Do not compress multiline options; textareas grow with content, and negative margins for mobile touch-target expansion remain.
- [ ] [Approved] UI uses a single icon set without emoji icons; icon-only actions have names; the interface has no development-plan numbers or internal jargon; delivery and execution states remain distinct.
- [ ] [Current] For charts, check text, gridlines, series, and tooltips in both themes; for existing animations, check that states remain readable with reduced motion.

### 8.2 Required Browser Assertions for Height Implementation

[Approved] In an isolated environment, use actual product code and a real browser to assert, at minimum, equal outer-frame heights and centerline deviation ≤ 1 px for these representative rows:

| Page | Same-row controls that must be compared |
|---|---|
| Overview | Search field and time-range segmented outer track |
| Usage and costs | Range segmented outer track, start/end dates, Apply button |
| Scheduled tasks | Segmented outer track, dropdowns, search, or other controls in the filter row |
| Conversations | Top switch outer track and same-row actions |

[Approved] The same assertions must fail against the old CSS. Review mutation tests provide the negative control; do not rewrite product source at runtime to introduce errors. Tests call actual product entry points rather than re-evaluating source code.

[Approved] When changing mobile or responsive layouts, run the affected gated browser tests (`ZYLOS_CHAT_INTEGRATION=1`), covering at least 390 px. If they cannot run, state the specific reason and remaining checks; static checks cannot substitute for a passing result.

[Approved] CSS changes also update the corresponding resource's `?v=` in [index.html](../public/index.html). Delivery records actual test files, commands, pass/fail counts, and exit codes. Keep inventory tables, retest tables, screenshots, and test logs in the PR; do not commit evidence artifacts to the repository.

[Approved] Run only checks relevant to this revision's scope and proven to be isolated. Organize tests according to the repository AGENTS.md rules for locations, naming, and lifecycle; do not touch live resources. For documentation-only revisions, state that there are no product or responsive changes, and check links, rule statuses, and the complete PR diff.
