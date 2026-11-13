# Dashboard 视觉设计规范（审阅稿）

适用：Dashboard 全部页面、抽屉、对话富内容、浅色/深色、桌面与手机。源码基准为 `8c08d8226b34db0ca8b3853a4a89c2be6ee5ebf6`（#1250 分段配色已包含）。本文先记录真实现状，再提出收敛方案；**所有「待 Howard 定」项都不是已批准要求。Howard 审批本规范后，才执行高度等视觉统一。** `--wb-h:32px`、`--c-h:36px` 是现有变量，不能据此宣称全站已统一，也不能把 26/30/44/52 提案当成已批准档位。

阅读约定：**现状**＝此基准静态源码或浏览器取证；**已批准**＝仅有明确批准的规则（本稿记录 #1250 共享分段配色）；**待 Howard 定**＝本文建议，不包含用户已明确要求的验收规则。源码链接相对于本文件 `skills/dashboard/docs/visual-design.md`；截图放 PR 正文，正文只记录截图文件名与用途。附录提供实际值全集，不要求读者逐行读完才做决定。

## 1. 设计 tokens：主题、层级、圆角、阴影、间距与字体

源文件：[基础样式](../public/css/style.css)、[浅色](../public/themes/light.css)、[深色](../public/themes/dark.css)、[工作台](../public/css/wb.css)、[对话](../public/css/conversation.css)。加载顺序是 style → light → dark → wb → wb-icons → conversation，旧规则存在不代表当前页面采用它；媒体查询、selector 与 DOM 都影响最终值。附录 A 保留局部覆盖与派生公式，附录 B 保留硬编码实际值。

### 1.1 主题颜色现状

| Token / 用途 | 浅色 | 深色 |
|---|---|---|
| `--bg` 页面 | `#f7faf9` | `#11171d` |
| `--bg-secondary` 次级层 | `rgba(255,255,255,.76)` | `#19222b` |
| `--bg-card` 基础卡片 | `rgba(255,255,255,.88)` | `#19222b` |
| `--bg-elevated` / `--wb-panel` 面板 | `#ffffff` | `#202c37` |
| `--bg-code` 代码 | `rgba(241,245,249,.9)` | `#15202b` |
| `--text` / `--text-dim` / `--text-muted` | `#101827` / `#526170` / `#7a8794` | `#e6edf3` / `#b1bfcc` / `#93a4b5` |
| `--accent` / `--accent-hover` / `--accent-dim` | `#0d9488` / `#0f766e` / `#ccfbf1` | `#43c7b5` / `#6cddcd` / `#173e3b` |
| `--purple` / `--green` | `#6366f1` / `#059669` | `#b0a5ff` / `#50c996` |
| `--border` / `--border-focus` | `rgba(15,118,110,.16)` / `rgba(14,165,163,.45)` | `#334656` / `#43c7b5` |
| `--nav-bg` | `rgba(255,255,255,.82)` | `#19222b` |
| `--state-offline/idle/busy/waiting` | `#64748b / #16a34a / #a16207 / #2563eb` | `#8b99a8 / #50c996 / #e9ba62 / #70a9ff` |
| `--state-possibly-stuck/stuck/unknown` | `#ea580c / #dc2626 / #6b7280` | `#f8a369 / #f77c87 / #9ba7b4` |

工作台另有固定 `--wb-work:#1b9d75`、`--wb-idle:#82b9ac`、`--wb-wait:#d69b35`、`--wb-err:#db5252`。线条为 text 的 8% / 13%，hover 为 4.5%；side 为 elevated55% 混 bg；accent-soft9%、accent-line32%。不要把 theme 的 busy 黄与工作台 busy 绿直接合并：后者表示正在工作，需先确认业务语义。

`--c-*` 是现用交互表面族：浅色 surface/raised=input=panel，sunken 为 text3.5% 混 surface；fill/hover/press 为 text3.5/6/9%，line8%，input line15→26%；深色 sunken=bg55% 混 surface，raised=text7% 混 surface，input=sunken，fill4.5/7.5/11%，line9%，input line13→24%。浅色 primary=`#0f766e`，hover/press 为 primary86/76% 混 black；danger=`#b84545`，hover/press90/80% 混 black；on-fill=`#f7faf9`。深色 primary=accent，hover=accent-hover，press=accent85% 混 bg，danger=wb-err（hover86%、press78% 混 text），on-fill=bg。其余 ink/soft/halo/line 的完整亮暗公式在附录 A。

图表不是只有主题色：[用量图](../public/js/wb/usage.js)固定系列 `#0d9488/#6366f1/#d97706`；[对话图](../public/js/wb/conversation-charts.js)固定系列 `#35a998/#e1a33d/#4f8cf7/#e06b83/#aa79e8/#73859f`。坐标和 tooltip 另读取主题；quota 是连续 HSL，不是离散成功/警告色。附录 C 列全 Canvas 数值与 fallback。

**待 Howard 定：**按页面/面板/凹槽/浮起选中面、正文/次正文/meta、primary/danger/success/waiting、图表系列整理语义 token；两套运行色和图表色逐项映射后再统一。禁止用「换成主题 token」掩盖语义冲突；有意保留的色需写用途和理由。

### 1.2 圆角与阴影现状及待定决策

基础圆角12/8/4，wb-r8，c-r-sm6（嵌套 thumb）/r8（控件）/r-lg12（卡片）；局部还有1/2/3/5/7/9/10/11/13/14/18/20/22、999px、50%、半边圆角和 calc（全集见附录）。chip13、tag5、pill20、sheet16 顶角、手机 composer22 是不同来源。

基础浅色 card 阴影=`0 18px 42px rgba(15,23,42,.08), inset 0 1px 0 rgba(255,255,255,.9)`，hover=`0 24px 52px rgba(15,23,42,.12), 0 0 24px rgba(13,148,136,.08)`；深色为 `0 10px 26px #0003`、hover `0 14px 32px #0005`。wb-shadow 继承这一族。c-shadow-card/btn/fill/thumb/xs 采用细 ring + 短投影（全部公式见附录 A）；局部仍有 `0 4px 16px rgba(0,0,0,.15)`、`0 8px 32px rgba(0,0,0,.2)`、`0 12px 32px rgba(10,15,20,.16)`、inset 选中线与 focus ring（附录 B 全列）。

**待 Howard 定：**建议控件8、嵌套thumb6、卡片12、底部sheet16、pill完全圆；局部13/11/22是否保留随家族逐项批准。建议卡片/按钮/实心按钮/选中thumb沿 c-shadow 语义命名，大投影仅浮层候选；焦点 ring 独立于 elevation。不能在审批前据此移除现有阴影。

### 1.3 间距与排版

现状基础空间4/8/16/24/32，c-pad20。实际 gap/padding/margin 有0/1/2/3/5/6/7/9/10/11/12/14/18/20/22/28/40/48等以及负边距、百分比、safe-area/calc；全集在附录 B。**待 Howard 定：**建议主节奏4/8/12/16/20/24/32，2/6用于密集组件内部；负边距、光学补偿、触控扩展和安全区各保留具名例外，不做全局四舍五入。

现状 Inter4.1 本地 `InterVariable.woff2`，变量字重100–900；中文回退 PingFang SC/Hiragino Sans GB/Microsoft YaHei/Noto Sans CJK SC/Source Han Sans SC，根字号14、行高1.5。等宽为 JetBrains Mono（index 引用 Google Fonts400）→ui-monospace/SFMono-Regular/Menlo。实际字号9/9.5/10/10.5/11/11.5/12/12.5/13/13.5/14/14.5/15/16/17/18/19/20、.92em、inherit、特殊0；字重400/450/500/550/600/650/700。行高1/1.2/1.3/1.35/1.4/1.45/1.5/1.55/1.6/1.65/1.7/1.8及15/16/18/20/22/24px。

**待 Howard 定：**候选层级为标题16/18/20，正文13/14，控件12/12.5，meta11/12；当前450/550/650不应未经批准改成整百。正文、帮助、图表刻度和微型徽标分别确认最低字号；对数字/耗时/价格保留 tabular-nums。对话正文14/24、字段说明12/18、标签13/20是明确的现用组合，应单独审阅。

## 2. 控件尺寸、家族与同行对齐

下表是**现状盘点**，不是目标档位。尺寸指 CSS px；高度包括边框；轨道高度包括 padding 与边框，不能拿内项高度与输入外框比较。

| 家族 | 当前尺寸 / 例外 | 来源 |
|---|---|---|
| 普通/主/危险按钮 | wb-btn30；sm26；settings32；对话问题按钮36；composer控制桌面40、手机44（早期30被后续变量覆盖） | wb.css141–158、1194；conversation.css471–512、824、1165起、1704–1709 |
| 图标按钮 / 链接 | icon30×30、sm24×24、header32×32；conversation-reload26×28；链接内容自适应 | wb.css154–161、202；conversation.css56 |
| 输入 / select / date / search | input28；select32；settings32；schedule输入34、textarea≥120；总览search26、schedule search32；对话字段36、textarea≥88 | wb.css165、303、694、774、850、987、1194；conversation.css1288起 |
| segment | wb-seg/seg2外轨32；seg-sm项行高18+轨道padding2；conversation项30+轨道padding2→34；引擎双行项min32+padding7，可增高 | wb.css169、634、1195–1204、1597；conversation.css41–54 |
| chip / tag / pill | chip26、radius13；tag11px字体/18px行高+2px边；pill min24；connection-pill28；question-status24 | wb.css235、327、492；style.css80；conversation.css1141 |
| switch / checkbox / radio | switch36×20、thumb16；tech微开关22×12/thumb8；富表单勾选框16×16；手机更多开关40×24/thumb18 | wb.css204、1242、1585；conversation.css1218 |
| 行与导航 | header48、tab30；settings nav34；conversation列表min58；手机topbar52、底tab56、更多项min52、settings导航min44 | wb.css183、1147、1428、1541起；conversation.css86 |
| 手机触控 | 多数范围min-height40、图标min-width40；settings44；新手机header icon44；对话compose控制44（附件可见宽40、高44，发送44×44），独立触控规则 | wb.css1484–1507、1547；conversation.css614、1704–1709 |

**待 Howard 定：**常规30、紧凑26可作为讨论起点；表单大字段、移动触控（候选44）、52高导航/多行条目要分开审批，不能拼成一套已批准26/30/44/52尺寸阶梯。现有32/34/36/40应逐家族决定保留或迁移；“--wb-h32”不等于所有32都应被30替代。标签、状态pill与纯装饰图形不机械套按钮高度。

**既定同行对齐要求：**同一工具行的输入、下拉、日期、按钮和分段**外轨道**等高，垂直中线差≤1px；项内部用flex居中；标签 baseline 对齐；多行字段说明在下一行，不能用margin-top补单一语言。换行后每一行内部继续对齐，长标题允许收缩/省略，操作区不得被挤出。例外（图标微操作、纯状态pill、双行引擎选择）需在规范中具名。

浏览器86状态调查的真实基线：桌面总览search26/segment外轨22，中线均146.5；390总览26/44，中线均272.25；用量range32/date32/date32/apply30，中线均84；聊天侧栏外轨34/reload28，中线均94。**等中线不等于等高；这些值仅证明现状，不代表尺寸通过验收。调查 bypass 了高度门禁，不能引用“86张截图”声称高度已统一。**

## 3. 交互状态与组件契约

| 家族 | 当前 default / hover / pressed / selected | 当前 focus / disabled / loading |
|---|---|---|
| 按钮（含icon、link） | default panel+line-strong/text；hover wb-hover；primary/danger各用c-*；active主/危险用press；icon hover text；link hover下划线 | wb通用outline2 offset2，primary/danger另有双ring（层叠需实测）；disabled普通.5/icon.38/link muted；对话action.45并active位移1；异步按操作禁用，未统一spinner |
| input/select/textarea/date/search | wb默认panel+line-strong；c字段hover line15→26（暗13→24）；focus为accent；invalid danger边；placeholder用meta | wb outline2 accent-line；c focus3px halo、invalid focus3px danger-soft；c禁用sunken/meta/无shadow；TTL与timezone特例opacity1+虚线；loading通常邻近文本，不假定字段自带spinner |
| segment | **#1250已批准**：凹轨c-sunken/padding2/gap2/border0；默认transparent+ink2/500；hover c-fill-hover+ink；selected c-raised+ink+c-shadow-thumb/600，圆角轨道减2 | focus outline2 border-focus offset-2；disabled.5/not-allowed；选中识别aria-selected/aria-pressed/.active/.wb-on/aria-expanded；当前无通用loading态。保持各使用点几何，颜色不回退为强调色底 |
| chip | wb-chip默认panel/dim/line-strong，pressed=accent-soft/accent/accent-line；对话form-chip另有checked/hover/active/invalid规则，见conversation.css1320起 | 普通chip继承通用规则，不把未定义hover/disabled宣称已实现；富表单focus跟随input、disabled沿家族；加载由父流程处理 |
| tag | 普通tag为紧凑元信息，mode-tag/pbadge/internal-badge有局部圆角/边线差异；不是所有tag都可点 | 只对交互tag设键盘焦点/hover；被动tag无selected/loading/disabled动作；不得凭外形赋予按钮语义 |
| pill | busy/starting绿色软底，busy点呼吸；idle淡绿点；waiting黄；error红；stopped空心，unknown虚线；连接pill另有live/degraded/polling/reconnecting | 被动pill无focus/disabled；可点pill按实际button/aria处理；reconnecting点脉冲，状态文字持续显示，不用动画代替状态 |
| switch | unchecked=line-strong，checked=accent，thumb panel+shadow；36×20 /16；sound button aria-pressed等价呈现；手机更多40×24 /18 | outline2 offset2；sound hover维持开/关底；没有完整统一disabled/loading状态。异步写入时须防重复并保留当前/目标状态说明（待定），不能假装已保存 |

源：[wb交互](../public/css/wb.css)、[富表单交互](../public/css/conversation.css)、[问题提交](../public/js/wb/chat-questions.js)、[对话页面](../public/js/wb/conversation-page.js)。对话radio/checkbox16px，checkbox圆角4、radio全圆；选中check为mask，radio中心3.5px。option默认fill，hover fill-hover+line，active fill-press，checked accent-soft+accent-line，focus叠c-focus，disabled option.55/checkbox.5。

加载现状：conversation activity旋转13px/1s，thinking三个4px点/1.2s，busy点2.4s；schedule读取为文本loading/readFailed，memory与conversation list另有loading/empty。reduced-motion禁用相关动画。**待 Howard 定：**统一按钮/字段禁用的可读性与透明度、焦点外框/嵌套/输入三种规则；loading必须可辨且防重复、避免布局跳动，是否采用spinner/aria-busy按家族补齐。不得把未实现状态写成现成组件能力；实现验收逐项覆盖 hover、focus-visible、selected/checked、disabled、loading、error及其组合。

## 4. 图标与视觉语言

现状：[wb-icons.css](../public/css/wb-icons.css)为本地SVG data URI CSS mask，Lucide geometry，24×24 viewBox、round cap/join、常规stroke1.75，通过currentColor着色；不是运行时引入Lucide npm包。[plain-text helper](../public/js/wb/plain-text.js)输出wb-ico类并aria-hidden=true。默认16，xs13，chevron12、bot13、composer18、手机nav22，具体覆盖见附录 B；图标盒子大小与触控盒子分别记录。

例外：`--c-ico-check` 使用2.5线宽（小型checkbox勾选），其他c chevron/alert/check-circle与附件mask1.75；index里的sound inline SVG2当前被switch样式隐藏。不能把隐藏SVG2写为可见主图标标准。

**既定图标要求：**UI导航、操作、状态使用同一套图标，不使用emoji代替图标；业务消息正文里的emoji不属于UI图标替换范围。**待 Howard 定：**建议延续本地图标集合与currentColor，常规1.75，check2.5是否作为小尺寸可识别性例外单独批准；新图形先复用已有mask，不引入第二套风格。纯图标操作有可访问名称，装饰图标aria-hidden，选中状态有文字/形状/aria，不单靠颜色。

## 5. 页面布局与信息层级

现状为单行header+instance strip+attention bar+全宽工作区+右侧详情抽屉；header48、左右16，无法容纳时header-fit切第二导航行并更新实测header高度。工作台主体、表格、卡片、图表、抽屉、设置两栏与对话三部分分别管理滚动。schedule侧抽屉480，top取实测header；memory基础grid为minmax(220,300)+minmax(0,1fr)。对话sidebar320/min260，内容卡片max720/c-pad20，消息正文与富内容宽度规则不同。不要把旧style header16/24 padding和tab36当成工作台当前布局。

**待 Howard 定：**保持“先状态、再行动、后技术细节”的层级：页面标题/范围、筛选工具行、主要内容、次级解释；同一类卡片标题与操作使用稳定边距。列表行中的名称、状态、耗时、操作各自对齐；表格数值右对齐、tabular-nums；长内容换行或省略时保证完整内容可访问。浮层只承担当前上下文任务，遮罩、z-index、关闭按钮、焦点进入/返回与背景滚动应浏览器验证。布局收敛不同时改变交互语义。

截图映射：`1280-light-overview.png` / `1280-dark-overview.png`用于主题、状态、图例；`1280-light-usage.png`用于卡片/图表/范围行；`1280-light-memory-file.png`用于树与内容层级；`1280-dark-schedule.png`用于深色任务列表；`1280-light-schedule-form.png`用于抽屉、字段与按钮；`1280-light-conversation-running.png`用于对话/正在工作/投递；`1280-light-settings-ui.png`用于设置、图标和开关。图片随 PR 提供，不复制到规范目录造成新的资产维护。

## 6. 响应式与390px手机验收

现状断点包含760px及页面专属断点，不能只查一个全局断点。手机底导航、更多sheet、设置侧抽屉、对话列表/详情切换采用不同容器。topbar52、icon44、底tab56；底部和sheet使用safe-area；conversation focus模式会隐藏topbar/底导航。settings导航抽屉宽min(300px,84vw)。手机触控规则的selector范围有限，总览search外框仍测得26，segment44；不能把CSS注释“所有可点≥40”当作已覆盖证明。

**待 Howard 定：**以用户要求的390px手机与1280px桌面为必测样本；320、760边界可在相关断点被修改时补测；保留当前主流程并逐页记录触控目标（候选44），区别可见图形与实际hit area。页面不得产生非预期横向滚动；图表/表格内部有意滚动要有容器边界；标题、中英文长按钮、日期范围、菜单末项、输入光标及错误文案均不能被裁。键盘弹起、safe-area、100dvh、固定composer和返回导航需要真浏览器检查。缩小宽度时允许工具行换行，但同一行仍执行第2节外框与中线规则。

截图映射：`390-light-overview.png`、`390-dark-overview.png`为390双主题静止矩阵；`390-light-mobile-more.png`为更多菜单/遮罩/开关；`390-light-settings-drawer.png`为设置抽屉。截图只证明所捕获状态；长文案、键盘与点击命中另验。

## 7. 文案与状态语义

**既定文案要求：**面向用户的界面不出现开发计划编号或内部黑话；使用用户能理解的状态词。技术细节视图中已有且对排障必要的诊断信息不属于开发计划编号。

使用实际i18n键：[通用中文](../public/i18n/zh.json)、[工作台中文](../public/i18n/wb.zh.json)，英文对应 [en](../public/i18n/en.json) / [wb.en](../public/i18n/wb.en.json)。字符串保留插值、数字与业务区别；视觉统一不改写状态事实。

| 类别 | 当前实际文案 / 区别 |
|---|---|
| 连接 | status.live「实时」、degraded「降级」、polling「轮询」、reconnecting「重连中」；对话push另为「实时更新已连接」/「实时更新未连接 · 轮询中」，连接正常不代表agent正在运行 |
| 工作台运行 | wb.state.busy「忙碌」、idle「空闲」、waiting「等待」、starting「启动中」、stopped/not_running/none「未运行」、running「运行中」、unknown「未知」、error「异常」；图例idle为「空闲（运行中）」 |
| 引擎登录 | wb.settings.health.unavailable「未登录」、unknown「状态未知」、available「已登录」；登录状态与进程运行、连接状态分开，不能把unavailable一律翻成离线 |
| 工作展示 | chat.working.processing「正在工作」；桌面scheduled「正在执行定时任务」，mobile「定时任务」；child/children均「后台子任务 {count} 个」，不要为视觉短句丢失数量 |
| 投递 | pending「已入库 · 待投递」、running「已入库 · 投递中」、delivered「已投递到运行会话」、stored「已入库」；已入库不等于已投递，已投递也不等于任务完成 |
| 异常与核对 | chat.page.delivery.failed「已入库 · 投递失败，不会自动重发」；auth_rejected「已入库 · 认证拒收，不能重发」；pending_reconciliation「状态待核对 · 请先核对再决定重试」；not_stored「未入库 · 已保留输入」。短chat.state版本与page版本并存，不能机械互换 |
| 定时任务 | schedule.status.failed「已失效」；schedule.result.failed「送达失败」是不同层；不能用统一“失败”替换 |
| 空/未知 | value.unknown/wb.unknown「未知」；memory.empty「选择一个记忆文件查看内容。」；usage未知不是0；schedule.empty「本机还没有定时任务」；timeline.empty「没有符合筛选的事件」；chat.empty「暂无对话」；page.emptyMine「还没有对话。\n新建一个，和 AI 单独聊一件事。」 |
| 操作 | chat.refresh「刷新」、chat.refreshStatus「核对投递状态」、wb.fleet.refresh「刷新状态」、memory.refresh「刷新记忆目录」、usage.apply「应用」；按钮名称反映动作对象，不为同宽而缩成同一词 |

**待 Howard 定：**颜色与上述语义一一建表，再做跨页归并；未知/空数据/离线/等待/失败分别有文字，恢复动作仅在真实可用时显示。状态先讲发生了什么、是否需操作，再提供细节。加载、成功、失败使用一致标点与省略号风格；中英文皆验证，禁止直接把内部错误码当唯一用户说明。没有文案审阅授权时保留现有i18n内容。

## 8. 可测量审阅清单与浏览器门禁

本次文档取证：public108个文件与基准一致、0 mismatch，86个状态截图。该次为survey，height gates bypassed，hover/focus还含静态断言；**不是统一高度实现的验收报告，也不能替代真实键盘/指针测试。** PR应明确区分“现状截图”“待定设计”“后续实现验收”。

以下清单用于视觉 PR 自查。用户已明确要求的同行等高、中线偏差≤1px、1280/390×亮/暗静止截图和代表性浏览器断言直接适用；具体高度档位仍待 Howard 定。本次仅交规范，实施仍须等 Howard 定稿。

- [ ] 每项设计决定带状态：已批准 / 待定 / 有意例外；没有把32/36现有变量或26/30/44/52候选当成已批准档位。变更值与附录基准差异逐项可追踪。
- [ ] light/dark ×1280/390的同页矩阵齐全；至少覆盖overview、usage、schedule列表/表单、settings、memory、conversation、mobile-more/drawer；固定测试数据、语言、主题、viewport、DPR与基准commit。
- [ ] 对每一条混合控件行记录boundingClientRect：search/filter+segment、usage range/date/date/apply、chat tabs/reload、settings input/select/button、schedule表单/筛选；按批准目标比较**外框高度**，中线差≤1px，不能只验中线；报告失败值，不屏蔽高度断言。
- [ ] 所有交互家族在真实浏览器触发hover、Tab focus-visible、selected/checked、disabled、loading、error；确认disabled无提交、键盘可达、焦点不被overflow裁掉；选中与focus同时可辨。静态selector检查只能补充，不能代替交互截图/断言。
- [ ] 390px逐页量测scrollWidth≤clientWidth（有意内部滚动容器另列）；无被遮标题/按钮/焦点；触控hit area符合批准下限；菜单/抽屉开关与关闭、滚动、返回、输入键盘、safe-area均可用。
- [ ] 在浏览器切主题后复查Canvas文字、格线、系列与tooltip；未知值不画成0，空数据有说明，系列不只靠颜色；检查高密度数字与长中文/英文。
- [ ] reduced-motion下关闭非必要呼吸/旋转并保留文字状态；离线/轮询/重连、长加载、投递失败与状态未知有可辨替代，不出现“卡住的spinner代表一切”。
- [ ] 新增图标来自本地mask集合且有名称/aria；UI无emoji代替图标；2.5 check例外与图标几何、视觉盒/点击盒均可追踪。
- [ ] HTML/CSS/JS控制台无新增错误；实际后端/持久化隔离的fixture浏览器验证，不触碰live；PR附截图映射、测量JSON、触发步骤、未解决项，评审者能重放。截图文件名使用第5/6节映射，缺失状态明确标记未验。

**后续高度实现必须加入 gated 浏览器断言：**至少覆盖总览搜索+分段外轨、用量范围+日期输入+应用、定时任务筛选行、对话页顶部切换行；调用真实产品代码，以外框高度相等及中线偏差≤1px为判断。旧CSS须能使相关断言失败；负对照由评审变异测试提供，不在运行时改写产品源码。CSS变更同步更新index.html对应资源的`?v=`。纯文档PR不新增或运行产品门禁。

**可选扩展（待 Howard 定）：**建议为文字/背景、必要图形与焦点增加对比度量测（普通文字4.5:1、大字及必要图形3:1），并按改动风险补320/760边界、200%缩放或键盘弹起场景；这些不是本次高度任务额外强制的全站矩阵。

审批顺序：Howard先确认本文各待定项 → 再实施尺寸/视觉收敛 → 重新运行上述真实浏览器门禁并提交新旧对照。本文本身不授予后续高度改动批准。

---

附录均为**基准实际声明**，不是推荐值；同属性不同值不一定都是缺陷，但在收敛时必须逐个归类为统一/语义差异/有意例外。所有冲突的收敛方向见第1–4节，决策状态统一为「待 Howard 定」。

## 附录 A. 非 SVG URL 变量与亮暗/局部覆盖

<details>
<summary>展开完整实际值与源码定位</summary>


### 六份样式中的非 SVG URL 变量声明（含亮暗/派生/局部覆盖，209条）

本表不含 SVG data-URI 图标变量；图标来源、线宽与例外见第4节及 wb-icons.css。209是声明条数，包含同名变量的主题/局部覆盖，不是209个独立token。

| 来源 | 上下文 / 选择器 | 属性 | 实际声明值 |
|---|---|---|---|
| [themes/light.css:2](../public/themes/light.css) | :root[data-theme="light"] | `--bg` | `#f7faf9` |
| [themes/light.css:3](../public/themes/light.css) | :root[data-theme="light"] | `--bg-secondary` | `rgba(255, 255, 255, 0.76)` |
| [themes/light.css:4](../public/themes/light.css) | :root[data-theme="light"] | `--bg-card` | `rgba(255, 255, 255, 0.88)` |
| [themes/light.css:5](../public/themes/light.css) | :root[data-theme="light"] | `--bg-elevated` | `#ffffff` |
| [themes/light.css:6](../public/themes/light.css) | :root[data-theme="light"] | `--bg-code` | `rgba(241, 245, 249, 0.9)` |
| [themes/light.css:7](../public/themes/light.css) | :root[data-theme="light"] | `--text` | `#101827` |
| [themes/light.css:8](../public/themes/light.css) | :root[data-theme="light"] | `--text-dim` | `#526170` |
| [themes/light.css:9](../public/themes/light.css) | :root[data-theme="light"] | `--text-muted` | `#7a8794` |
| [themes/light.css:10](../public/themes/light.css) | :root[data-theme="light"] | `--accent` | `#0d9488` |
| [themes/light.css:11](../public/themes/light.css) | :root[data-theme="light"] | `--accent-dim` | `#ccfbf1` |
| [themes/light.css:12](../public/themes/light.css) | :root[data-theme="light"] | `--accent-hover` | `#0f766e` |
| [themes/light.css:13](../public/themes/light.css) | :root[data-theme="light"] | `--purple` | `#6366f1` |
| [themes/light.css:14](../public/themes/light.css) | :root[data-theme="light"] | `--green` | `#059669` |
| [themes/light.css:15](../public/themes/light.css) | :root[data-theme="light"] | `--border` | `rgba(15, 118, 110, 0.16)` |
| [themes/light.css:16](../public/themes/light.css) | :root[data-theme="light"] | `--border-focus` | `rgba(14, 165, 163, 0.45)` |
| [themes/light.css:17](../public/themes/light.css) | :root[data-theme="light"] | `--nav-bg` | `rgba(255, 255, 255, 0.82)` |
| [themes/light.css:18](../public/themes/light.css) | :root[data-theme="light"] | `--shadow-card` | `0 18px 42px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.9)` |
| [themes/light.css:19](../public/themes/light.css) | :root[data-theme="light"] | `--shadow-card-hover` | `0 24px 52px rgba(15, 23, 42, 0.12), 0 0 24px rgba(13, 148, 136, 0.08)` |
| [themes/light.css:20](../public/themes/light.css) | :root[data-theme="light"] | `--state-offline` | `#64748b` |
| [themes/light.css:21](../public/themes/light.css) | :root[data-theme="light"] | `--state-idle` | `#16a34a` |
| [themes/light.css:22](../public/themes/light.css) | :root[data-theme="light"] | `--state-busy` | `#a16207` |
| [themes/light.css:23](../public/themes/light.css) | :root[data-theme="light"] | `--state-waiting` | `#2563eb` |
| [themes/light.css:24](../public/themes/light.css) | :root[data-theme="light"] | `--state-possibly-stuck` | `#ea580c` |
| [themes/light.css:25](../public/themes/light.css) | :root[data-theme="light"] | `--state-stuck` | `#dc2626` |
| [themes/light.css:26](../public/themes/light.css) | :root[data-theme="light"] | `--state-unknown` | `#6b7280` |
| [themes/dark.css:3](../public/themes/dark.css) | :root[data-theme="dark"] | `--bg` | `#11171d` |
| [themes/dark.css:4](../public/themes/dark.css) | :root[data-theme="dark"] | `--bg-secondary` | `#19222b` |
| [themes/dark.css:5](../public/themes/dark.css) | :root[data-theme="dark"] | `--bg-card` | `#19222b` |
| [themes/dark.css:6](../public/themes/dark.css) | :root[data-theme="dark"] | `--bg-elevated` | `#202c37` |
| [themes/dark.css:7](../public/themes/dark.css) | :root[data-theme="dark"] | `--bg-code` | `#15202b` |
| [themes/dark.css:8](../public/themes/dark.css) | :root[data-theme="dark"] | `--text` | `#e6edf3` |
| [themes/dark.css:9](../public/themes/dark.css) | :root[data-theme="dark"] | `--text-dim` | `#b1bfcc` |
| [themes/dark.css:10](../public/themes/dark.css) | :root[data-theme="dark"] | `--text-muted` | `#93a4b5` |
| [themes/dark.css:11](../public/themes/dark.css) | :root[data-theme="dark"] | `--accent` | `#43c7b5` |
| [themes/dark.css:12](../public/themes/dark.css) | :root[data-theme="dark"] | `--accent-dim` | `#173e3b` |
| [themes/dark.css:13](../public/themes/dark.css) | :root[data-theme="dark"] | `--accent-hover` | `#6cddcd` |
| [themes/dark.css:14](../public/themes/dark.css) | :root[data-theme="dark"] | `--purple` | `#b0a5ff` |
| [themes/dark.css:15](../public/themes/dark.css) | :root[data-theme="dark"] | `--green` | `#50c996` |
| [themes/dark.css:16](../public/themes/dark.css) | :root[data-theme="dark"] | `--border` | `#334656` |
| [themes/dark.css:17](../public/themes/dark.css) | :root[data-theme="dark"] | `--border-focus` | `#43c7b5` |
| [themes/dark.css:18](../public/themes/dark.css) | :root[data-theme="dark"] | `--nav-bg` | `#19222b` |
| [themes/dark.css:19](../public/themes/dark.css) | :root[data-theme="dark"] | `--shadow-card` | `0 10px 26px #0003` |
| [themes/dark.css:20](../public/themes/dark.css) | :root[data-theme="dark"] | `--shadow-card-hover` | `0 14px 32px #0005` |
| [themes/dark.css:21](../public/themes/dark.css) | :root[data-theme="dark"] | `--state-offline` | `#8b99a8` |
| [themes/dark.css:22](../public/themes/dark.css) | :root[data-theme="dark"] | `--state-idle` | `#50c996` |
| [themes/dark.css:23](../public/themes/dark.css) | :root[data-theme="dark"] | `--state-busy` | `#e9ba62` |
| [themes/dark.css:24](../public/themes/dark.css) | :root[data-theme="dark"] | `--state-waiting` | `#70a9ff` |
| [themes/dark.css:25](../public/themes/dark.css) | :root[data-theme="dark"] | `--state-possibly-stuck` | `#f8a369` |
| [themes/dark.css:26](../public/themes/dark.css) | :root[data-theme="dark"] | `--state-stuck` | `#f77c87` |
| [themes/dark.css:27](../public/themes/dark.css) | :root[data-theme="dark"] | `--state-unknown` | `#9ba7b4` |
| [css/style.css:11](../public/css/style.css) | :root | `--radius` | `12px` |
| [css/style.css:12](../public/css/style.css) | :root | `--radius-sm` | `8px` |
| [css/style.css:13](../public/css/style.css) | :root | `--radius-xs` | `4px` |
| [css/style.css:14](../public/css/style.css) | :root | `--space-xs` | `4px` |
| [css/style.css:15](../public/css/style.css) | :root | `--space-sm` | `8px` |
| [css/style.css:16](../public/css/style.css) | :root | `--space-md` | `16px` |
| [css/style.css:17](../public/css/style.css) | :root | `--space-lg` | `24px` |
| [css/style.css:18](../public/css/style.css) | :root | `--space-xl` | `32px` |
| [css/style.css:724](../public/css/style.css) | .agent-link-chip.link-slow | `--link-color` | `#f59e0b` |
| [css/style.css:725](../public/css/style.css) | .agent-link-chip.link-degraded | `--link-color` | `#d97706` |
| [css/style.css:726](../public/css/style.css) | .agent-link-chip.link-stale | `--link-color` | `#64748b` |
| [css/wb.css:4](../public/css/wb.css) | :root | `--wb-line` | `color-mix(in srgb, var(--text) 8%, transparent)` |
| [css/wb.css:5](../public/css/wb.css) | :root | `--wb-line-strong` | `color-mix(in srgb, var(--text) 13%, transparent)` |
| [css/wb.css:6](../public/css/wb.css) | :root | `--wb-hover` | `color-mix(in srgb, var(--text) 4.5%, transparent)` |
| [css/wb.css:7](../public/css/wb.css) | :root | `--wb-panel` | `var(--bg-elevated)` |
| [css/wb.css:8](../public/css/wb.css) | :root | `--wb-side` | `color-mix(in srgb, var(--bg-elevated) 55%, var(--bg))` |
| [css/wb.css:9](../public/css/wb.css) | :root | `--wb-accent-soft` | `color-mix(in srgb, var(--accent) 9%, transparent)` |
| [css/wb.css:10](../public/css/wb.css) | :root | `--wb-accent-line` | `color-mix(in srgb, var(--accent) 32%, transparent)` |
| [css/wb.css:11](../public/css/wb.css) | :root | `--wb-work` | `#1b9d75` |
| [css/wb.css:12](../public/css/wb.css) | :root | `--wb-idle` | `#82b9ac` |
| [css/wb.css:13](../public/css/wb.css) | :root | `--wb-wait` | `#d69b35` |
| [css/wb.css:14](../public/css/wb.css) | :root | `--wb-err` | `#db5252` |
| [css/wb.css:15](../public/css/wb.css) | :root | `--wb-quota-lightness` | `26%` |
| [css/wb.css:16](../public/css/wb.css) | :root | `--wb-quota-fill-saturation` | `85%` |
| [css/wb.css:17](../public/css/wb.css) | :root | `--wb-quota-fill-lightness` | `45%` |
| [css/wb.css:18](../public/css/wb.css) | :root | `--wb-quota-outline` | `inset 0 0 0 1px var(--text)` |
| [css/wb.css:19](../public/css/wb.css) | :root | `--wb-off` | `color-mix(in srgb, var(--text) 14%, transparent)` |
| [css/wb.css:20](../public/css/wb.css) | :root | `--wb-h` | `32px` |
| [css/wb.css:21](../public/css/wb.css) | :root | `--wb-r` | `8px` |
| [css/wb.css:23](../public/css/wb.css) | :root | `--wb-header-h` | `var(--wb-header-measured, 48px)` |
| [css/wb.css:24](../public/css/wb.css) | :root | `--wb-shadow` | `var(--shadow-card)` |
| [css/wb.css:26](../public/css/wb.css) | :root | `--wb-scrim` | `color-mix(in srgb, var(--text) 30%, transparent)` |
| [css/wb.css:27](../public/css/wb.css) | :root | `--wb-on-fill` | `var(--bg)` |
| [css/wb.css:29](../public/css/wb.css) | :root[data-theme="dark"] | `--wb-quota-lightness` | `68%` |
| [css/wb.css:29](../public/css/wb.css) | :root[data-theme="dark"] | `--wb-quota-fill-saturation` | `75%` |
| [css/wb.css:29](../public/css/wb.css) | :root[data-theme="dark"] | `--wb-quota-fill-lightness` | `68%` |
| [css/wb.css:29](../public/css/wb.css) | :root[data-theme="dark"] | `--wb-quota-outline` | `none` |
| [css/wb.css:29](../public/css/wb.css) | :root[data-theme="dark"] | `--wb-scrim` | `color-mix(in srgb, var(--bg) 72%, transparent)` |
| [css/wb.css:33](../public/css/wb.css) | :root | `--c-max` | `720px` |
| [css/wb.css:34](../public/css/wb.css) | :root | `--c-pad` | `20px` |
| [css/wb.css:35](../public/css/wb.css) | :root | `--c-h` | `36px` |
| [css/wb.css:36](../public/css/wb.css) | :root | `--c-r-sm` | `6px` |
| [css/wb.css:37](../public/css/wb.css) | :root | `--c-r` | `8px` |
| [css/wb.css:38](../public/css/wb.css) | :root | `--c-r-lg` | `12px` |
| [css/wb.css:39](../public/css/wb.css) | :root | `--c-input-fs` | `14px` |
| [css/wb.css:40](../public/css/wb.css) | :root | `--c-ease` | `cubic-bezier(.2, 0, 0, 1)` |
| [css/wb.css:41](../public/css/wb.css) | :root | `--c-dur` | `150ms` |
| [css/wb.css:44](../public/css/wb.css) | :root | `--c-surface` | `var(--wb-panel)` |
| [css/wb.css:45](../public/css/wb.css) | :root | `--c-sunken` | `color-mix(in srgb, var(--text) 3.5%, var(--c-surface))` |
| [css/wb.css:46](../public/css/wb.css) | :root | `--c-raised` | `var(--wb-panel)` |
| [css/wb.css:47](../public/css/wb.css) | :root | `--c-input-bg` | `var(--c-surface)` |
| [css/wb.css:48](../public/css/wb.css) | :root | `--c-fill` | `color-mix(in srgb, var(--text) 3.5%, transparent)` |
| [css/wb.css:49](../public/css/wb.css) | :root | `--c-fill-hover` | `color-mix(in srgb, var(--text) 6%, transparent)` |
| [css/wb.css:50](../public/css/wb.css) | :root | `--c-fill-press` | `color-mix(in srgb, var(--text) 9%, transparent)` |
| [css/wb.css:51](../public/css/wb.css) | :root | `--c-line` | `color-mix(in srgb, var(--text) 8%, transparent)` |
| [css/wb.css:52](../public/css/wb.css) | :root | `--c-line-input` | `color-mix(in srgb, var(--text) 15%, transparent)` |
| [css/wb.css:53](../public/css/wb.css) | :root | `--c-line-input-hover` | `color-mix(in srgb, var(--text) 26%, transparent)` |
| [css/wb.css:54](../public/css/wb.css) | :root | `--c-control-edge` | `var(--text-muted)` |
| [css/wb.css:57](../public/css/wb.css) | :root | `--c-ink` | `var(--text)` |
| [css/wb.css:58](../public/css/wb.css) | :root | `--c-ink-2` | `var(--text-dim)` |
| [css/wb.css:59](../public/css/wb.css) | :root | `--c-ink-meta` | `color-mix(in srgb, var(--text-dim) 60%, var(--text-muted))` |
| [css/wb.css:62](../public/css/wb.css) | :root | `--c-primary` | `#0f766e` |
| [css/wb.css:63](../public/css/wb.css) | :root | `--c-on-fill` | `#f7faf9` |
| [css/wb.css:64](../public/css/wb.css) | :root | `--c-primary-hover` | `color-mix(in srgb, var(--c-primary) 86%, black)` |
| [css/wb.css:65](../public/css/wb.css) | :root | `--c-primary-press` | `color-mix(in srgb, var(--c-primary) 76%, black)` |
| [css/wb.css:66](../public/css/wb.css) | :root | `--c-accent-ink` | `var(--accent-hover)` |
| [css/wb.css:67](../public/css/wb.css) | :root | `--c-accent-soft` | `color-mix(in srgb, var(--accent) 9%, transparent)` |
| [css/wb.css:68](../public/css/wb.css) | :root | `--c-accent-line` | `color-mix(in srgb, var(--accent) 45%, transparent)` |
| [css/wb.css:69](../public/css/wb.css) | :root | `--c-accent-halo` | `color-mix(in srgb, var(--accent) 22%, transparent)` |
| [css/wb.css:70](../public/css/wb.css) | :root | `--c-danger` | `#b84545` |
| [css/wb.css:71](../public/css/wb.css) | :root | `--c-danger-hover` | `color-mix(in srgb, var(--c-danger) 90%, black)` |
| [css/wb.css:72](../public/css/wb.css) | :root | `--c-danger-press` | `color-mix(in srgb, var(--c-danger) 80%, black)` |
| [css/wb.css:73](../public/css/wb.css) | :root | `--c-danger-ink` | `color-mix(in srgb, var(--wb-err) 75%, var(--text))` |
| [css/wb.css:74](../public/css/wb.css) | :root | `--c-danger-soft` | `color-mix(in srgb, var(--wb-err) 8%, transparent)` |
| [css/wb.css:75](../public/css/wb.css) | :root | `--c-danger-line` | `color-mix(in srgb, var(--wb-err) 22%, transparent)` |
| [css/wb.css:76](../public/css/wb.css) | :root | `--c-success-ink` | `color-mix(in srgb, var(--wb-work) 70%, var(--text))` |
| [css/wb.css:77](../public/css/wb.css) | :root | `--c-success-soft` | `color-mix(in srgb, var(--wb-work) 9%, transparent)` |
| [css/wb.css:80](../public/css/wb.css) | :root | `--c-shadow-card` | `0 0 0 1px color-mix(in srgb, var(--text) 7%, transparent), 0 1px 2px color-mix(in srgb, var(--text) 4%, transparent), 0 4px 12px -4px color-mix(in srgb, var(--text) 6%, transparent)` |
| [css/wb.css:83](../public/css/wb.css) | :root | `--c-shadow-xs` | `0 1px 2px color-mix(in srgb, var(--text) 5%, transparent)` |
| [css/wb.css:84](../public/css/wb.css) | :root | `--c-shadow-btn` | `0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent), 0 1px 2px color-mix(in srgb, var(--text) 5%, transparent)` |
| [css/wb.css:85](../public/css/wb.css) | :root | `--c-shadow-fill` | `inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent), 0 1px 2px color-mix(in srgb, var(--text) 14%, transparent)` |
| [css/wb.css:86](../public/css/wb.css) | :root | `--c-shadow-thumb` | `0 0 0 1px color-mix(in srgb, var(--text) 8%, transparent), 0 1px 3px color-mix(in srgb, var(--text) 10%, transparent)` |
| [css/wb.css:87](../public/css/wb.css) | :root | `--c-focus` | `0 0 0 2px var(--c-surface), 0 0 0 4px color-mix(in srgb, var(--accent) 75%, transparent)` |
| [css/wb.css:98](../public/css/wb.css) | :root[data-theme="dark"] | `--c-primary` | `var(--accent)` |
| [css/wb.css:99](../public/css/wb.css) | :root[data-theme="dark"] | `--c-primary-hover` | `var(--accent-hover)` |
| [css/wb.css:100](../public/css/wb.css) | :root[data-theme="dark"] | `--c-primary-press` | `color-mix(in srgb, var(--accent) 85%, var(--bg))` |
| [css/wb.css:101](../public/css/wb.css) | :root[data-theme="dark"] | `--c-danger` | `var(--wb-err)` |
| [css/wb.css:102](../public/css/wb.css) | :root[data-theme="dark"] | `--c-danger-hover` | `color-mix(in srgb, var(--wb-err) 86%, var(--text))` |
| [css/wb.css:103](../public/css/wb.css) | :root[data-theme="dark"] | `--c-danger-press` | `color-mix(in srgb, var(--wb-err) 78%, var(--text))` |
| [css/wb.css:104](../public/css/wb.css) | :root[data-theme="dark"] | `--c-on-fill` | `var(--wb-on-fill)` |
| [css/wb.css:105](../public/css/wb.css) | :root[data-theme="dark"] | `--c-sunken` | `color-mix(in srgb, var(--bg) 55%, var(--c-surface))` |
| [css/wb.css:106](../public/css/wb.css) | :root[data-theme="dark"] | `--c-raised` | `color-mix(in srgb, var(--text) 7%, var(--c-surface))` |
| [css/wb.css:107](../public/css/wb.css) | :root[data-theme="dark"] | `--c-input-bg` | `var(--c-sunken)` |
| [css/wb.css:108](../public/css/wb.css) | :root[data-theme="dark"] | `--c-fill` | `color-mix(in srgb, var(--text) 4.5%, transparent)` |
| [css/wb.css:109](../public/css/wb.css) | :root[data-theme="dark"] | `--c-fill-hover` | `color-mix(in srgb, var(--text) 7.5%, transparent)` |
| [css/wb.css:110](../public/css/wb.css) | :root[data-theme="dark"] | `--c-fill-press` | `color-mix(in srgb, var(--text) 11%, transparent)` |
| [css/wb.css:111](../public/css/wb.css) | :root[data-theme="dark"] | `--c-line` | `color-mix(in srgb, var(--text) 9%, transparent)` |
| [css/wb.css:112](../public/css/wb.css) | :root[data-theme="dark"] | `--c-line-input` | `color-mix(in srgb, var(--text) 13%, transparent)` |
| [css/wb.css:113](../public/css/wb.css) | :root[data-theme="dark"] | `--c-line-input-hover` | `color-mix(in srgb, var(--text) 24%, transparent)` |
| [css/wb.css:114](../public/css/wb.css) | :root[data-theme="dark"] | `--c-ink-meta` | `var(--text-muted)` |
| [css/wb.css:115](../public/css/wb.css) | :root[data-theme="dark"] | `--c-accent-ink` | `var(--accent)` |
| [css/wb.css:116](../public/css/wb.css) | :root[data-theme="dark"] | `--c-accent-soft` | `color-mix(in srgb, var(--accent) 13%, transparent)` |
| [css/wb.css:117](../public/css/wb.css) | :root[data-theme="dark"] | `--c-accent-line` | `color-mix(in srgb, var(--accent) 50%, transparent)` |
| [css/wb.css:118](../public/css/wb.css) | :root[data-theme="dark"] | `--c-accent-halo` | `color-mix(in srgb, var(--accent) 28%, transparent)` |
| [css/wb.css:119](../public/css/wb.css) | :root[data-theme="dark"] | `--c-danger-ink` | `color-mix(in srgb, var(--wb-err) 60%, var(--text))` |
| [css/wb.css:120](../public/css/wb.css) | :root[data-theme="dark"] | `--c-danger-soft` | `color-mix(in srgb, var(--wb-err) 14%, transparent)` |
| [css/wb.css:121](../public/css/wb.css) | :root[data-theme="dark"] | `--c-danger-line` | `color-mix(in srgb, var(--wb-err) 30%, transparent)` |
| [css/wb.css:122](../public/css/wb.css) | :root[data-theme="dark"] | `--c-success-ink` | `color-mix(in srgb, var(--wb-work) 60%, var(--text))` |
| [css/wb.css:123](../public/css/wb.css) | :root[data-theme="dark"] | `--c-success-soft` | `color-mix(in srgb, var(--wb-work) 15%, transparent)` |
| [css/wb.css:124](../public/css/wb.css) | :root[data-theme="dark"] | `--c-shadow-card` | `0 0 0 1px color-mix(in srgb, var(--text) 8%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 5%, transparent), 0 1px 2px rgb(0 0 0 / .3), 0 6px 16px -6px rgb(0 0 0 / .45)` |
| [css/wb.css:127](../public/css/wb.css) | :root[data-theme="dark"] | `--c-shadow-xs` | `0 1px 2px rgb(0 0 0 / .25)` |
| [css/wb.css:128](../public/css/wb.css) | :root[data-theme="dark"] | `--c-shadow-btn` | `0 0 0 1px color-mix(in srgb, var(--text) 13%, transparent), 0 1px 2px rgb(0 0 0 / .25)` |
| [css/wb.css:129](../public/css/wb.css) | :root[data-theme="dark"] | `--c-shadow-fill` | `inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent), 0 1px 2px rgb(0 0 0 / .3)` |
| [css/wb.css:130](../public/css/wb.css) | :root[data-theme="dark"] | `--c-shadow-thumb` | `0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent), 0 1px 3px rgb(0 0 0 / .4)` |
| [css/wb.css:565](../public/css/wb.css) | @media (max-width: 760px) / :root | `--wb-header-h` | `0px` |
| [css/wb.css:698](../public/css/wb.css) | .wb-sched-table | `--wb-sched-cols` | `minmax(220px, 2.3fr) minmax(120px, 1.3fr) 118px 160px minmax(110px, 1fr) minmax(72px, max-content)` |
| [css/wb.css:792](../public/css/wb.css) | @media (min-width: 901px) / .wb-schedule.wb-has-side .wb-sched-table | `--wb-sched-cols` | `minmax(180px, 2fr) minmax(110px, 1.2fr) 110px 150px` |
| [css/wb.css:798](../public/css/wb.css) | @media (max-width: 1100px) / .wb-sched-table | `--wb-sched-cols` | `minmax(150px, 2fr) minmax(96px, 1fr) 100px 112px minmax(84px, 1fr) minmax(64px, max-content)` |
| [css/wb.css:804](../public/css/wb.css) | @media (min-width: 901px) and (max-width: 1180px) / .wb-schedule.wb-has-side .wb-sched-table | `--wb-sched-cols` | `minmax(0, 2fr) minmax(90px, 1fr) 104px` |
| [css/wb.css:1501](../public/css/wb.css) | @media (max-width: 760px) / .wb-sched-timeline .wb-sched-dot | `--wb-dot` | `var(--text-dim)` |
| [css/wb.css:1501](../public/css/wb.css) | @media (max-width: 760px) / .wb-sched-timeline .wb-sched-dot | `--wb-dot-ring` | `none` |
| [css/wb.css:1503](../public/css/wb.css) | @media (max-width: 760px) / .wb-sched-timeline .wb-sched-dot.wb-p1 | `--wb-dot` | `var(--wb-wait)` |
| [css/wb.css:1505](../public/css/wb.css) | @media (max-width: 760px) / .wb-sched-timeline .wb-sched-dot:hover | `--wb-dot` | `var(--text)` |
| [css/wb.css:1506](../public/css/wb.css) | @media (max-width: 760px) / .wb-sched-timeline .wb-sched-dot.active | `--wb-dot` | `var(--accent)` |
| [css/wb.css:1506](../public/css/wb.css) | @media (max-width: 760px) / .wb-sched-timeline .wb-sched-dot.active | `--wb-dot-ring` | `0 0 0 3px var(--wb-accent-soft)` |
| [css/wb.css:1536](../public/css/wb.css) | @media (max-width: 760px) / html.wb-mobile-ready | `--wb-header-h` | `52px` |
| [css/wb.css:1591](../public/css/wb.css) | @media (max-width: 760px) / html.wb-mobile-ready[data-conversation-focus="true"] | `--wb-header-h` | `0px` |
| [css/wb.css:1600](../public/css/wb.css) | :is(.conversation-tabs, .wb-seg, .wb-seg2, .wb-seg-sm) | `--wb-segment-radius` | `var(--wb-r)` |
| [css/wb.css:1607](../public/css/wb.css) | .wb-seg-sm | `--wb-segment-radius` | `6px` |
| [css/conversation.css:471](../public/css/conversation.css) | .conversation-compose-box | `--conversation-control-height` | `30px` |
| [css/conversation.css:614](../public/css/conversation.css) | @media(max-width:760px) / .conversation-compose-box | `--conversation-control-height` | `40px` |
| [css/conversation.css:824](../public/css/conversation.css) | .conversation-compose-box | `--conversation-control-height` | `40px` |
| [css/conversation.css:1027](../public/css/conversation.css) | .conversation-internal | `--conversation-internal-bg` | `#f1eee7` |
| [css/conversation.css:1028](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-internal | `--conversation-internal-bg` | `#353027` |
| [css/conversation.css:1448](../public/css/conversation.css) | @media (max-width: 760px) / :root | `--c-pad` | `16px` |
| [css/conversation.css:1448](../public/css/conversation.css) | @media (max-width: 760px) / :root | `--c-h` | `40px` |
| [css/conversation.css:1448](../public/css/conversation.css) | @media (max-width: 760px) / :root | `--c-input-fs` | `16px` |
| [css/conversation.css:1601](../public/css/conversation.css) | .conversation-header | `--wi-c1` | `#1b9d75` |
| [css/conversation.css:1601](../public/css/conversation.css) | .conversation-header | `--wi-c2` | `#14b3a3` |
| [css/conversation.css:1601](../public/css/conversation.css) | .conversation-header | `--wi-c3` | `#1fb5c9` |
| [css/conversation.css:1601](../public/css/conversation.css) | .conversation-header | `--wi-c4` | `#3f8ff0` |
| [css/conversation.css:1601](../public/css/conversation.css) | .conversation-header | `--wi-c5` | `#7a6cf0` |
| [css/conversation.css:1601](../public/css/conversation.css) | .conversation-header | `--wi-c6` | `#c45fe0` |
| [css/conversation.css:1601](../public/css/conversation.css) | .conversation-header | `--wi-c7` | `#ff6fa8` |
| [css/conversation.css:1601](../public/css/conversation.css) | .conversation-header | `--wi-glow` | `rgba(196,95,224,.6)` |
| [css/conversation.css:1602](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-header | `--wi-c1` | `#43c7b5` |
| [css/conversation.css:1602](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-header | `--wi-c2` | `#4fd6c4` |
| [css/conversation.css:1602](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-header | `--wi-c3` | `#5fd8ea` |
| [css/conversation.css:1602](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-header | `--wi-c4` | `#7aa8ff` |
| [css/conversation.css:1602](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-header | `--wi-c5` | `#a593ff` |
| [css/conversation.css:1602](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-header | `--wi-c6` | `#e08cff` |
| [css/conversation.css:1602](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-header | `--wi-c7` | `#ff9cc6` |
| [css/conversation.css:1602](../public/css/conversation.css) | :root[data-theme="dark"] .conversation-header | `--wi-glow` | `rgba(190,160,255,.7)` |
| [css/conversation.css:1604](../public/css/conversation.css) | .conversation-header .wi-comet | `--wi-rx` | `13.25px` |
| [css/conversation.css:1604](../public/css/conversation.css) | .conversation-header .wi-comet | `--wi-t` | `2.6s` |
| [css/conversation.css:1649](../public/css/conversation.css) | @media (max-width:760px) / .conversation-page .conversation-tabs | `--wb-segment-radius` | `10px` |
| [css/conversation.css:1695](../public/css/conversation.css) | @media (max-width:760px) / .conversation-header .wi-comet | `--wi-rx` | `10.25px` |
| [css/conversation.css:1695](../public/css/conversation.css) | @media (max-width:760px) / .conversation-header .wi-comet | `--wi-t` | `2.2s` |
| [css/conversation.css:1704](../public/css/conversation.css) | @media (max-width:760px) / .conversation-page .conversation-compose-box | `--conversation-control-height` | `44px` |




</details>

## 附录 B. 视觉相关 CSS 属性的完整取值索引

<details>
<summary>展开完整实际值与源码定位</summary>

范围：六份样式文件（style、亮/暗主题、wb、wb-icons、conversation）中的下列76个视觉相关属性；每个属性列出解析所得的全部去重声明值，包含旧规则、主题与媒体查询覆盖。不是全站computed-style结果，也不把几何不同都判为缺陷。`height`、`min-height`等读取全部声明，不只图标或交互态规则。源码行号指该值首个声明，具体适用范围仍须回到selector、层叠和DOM核对。

### `-webkit-mask`（6种）

| 实际值 | 首个来源 |
|---|---|
| `var(--wb-ico) center/contain no-repeat` | [css/wb.css:163](../public/css/wb.css) |
| `linear-gradient(currentColor 70%, transparent)` | [css/wb.css:751](../public/css/wb.css) |
| `var(--c-ico-check) center/contain no-repeat` | [css/conversation.css:1158](../public/css/conversation.css) |
| `var(--c-ico-chev) center/contain no-repeat` | [css/conversation.css:1208](../public/css/conversation.css) |
| `var(--c-ico-check-circle) center/contain no-repeat` | [css/conversation.css:1279](../public/css/conversation.css) |
| `var(--c-ico-alert) center/contain no-repeat` | [css/conversation.css:1365](../public/css/conversation.css) |

### `-webkit-text-fill-color`（1种）

| 实际值 | 首个来源 |
|---|---|
| `var(--text-muted)` | [css/wb.css:168](../public/css/wb.css) |

### `accent-color`（1种）

| 实际值 | 首个来源 |
|---|---|
| `var(--accent)` | [css/wb.css:783](../public/css/wb.css) |

### `align-items`（7种）

| 实际值 | 首个来源 |
|---|---|
| `center` | [css/style.css:45](../public/css/style.css) |
| `baseline` | [css/style.css:60](../public/css/style.css) |
| `flex-start` | [css/style.css:224](../public/css/style.css) |
| `start` | [css/style.css:759](../public/css/style.css) |
| `stretch` | [css/style.css:1014](../public/css/style.css) |
| `flex-end` | [css/style.css:1092](../public/css/style.css) |
| `end` | [css/wb.css:1232](../public/css/wb.css) |

### `align-self`（4种）

| 实际值 | 首个来源 |
|---|---|
| `center` | [css/style.css:153](../public/css/style.css) |
| `flex-start` | [css/wb.css:1146](../public/css/wb.css) |
| `stretch` | [css/wb.css:1425](../public/css/wb.css) |
| `start` | [css/conversation.css:1438](../public/css/conversation.css) |

### `animation`（13种）

| 实际值 | 首个来源 |
|---|---|
| `pulse-dot 1.5s ease-in-out infinite` | [css/style.css:133](../public/css/style.css) |
| `tool-enter 200ms ease` | [css/style.css:833](../public/css/style.css) |
| `wb-breathe 2.4s ease-in-out infinite` | [css/wb.css:330](../public/css/wb.css) |
| `none !important` | [css/wb.css:342](../public/css/wb.css) |
| `conversation-activity-spin 1s linear infinite` | [css/conversation.css:966](../public/css/conversation.css) |
| `conversation-activity-dot 1.2s infinite` | [css/conversation.css:980](../public/css/conversation.css) |
| `none` | [css/conversation.css:986](../public/css/conversation.css) |
| `conversation-flash .32s var(--c-ease)` | [css/conversation.css:1504](../public/css/conversation.css) |
| `conversation-flash 1.4s var(--c-ease)` | [css/conversation.css:1517](../public/css/conversation.css) |
| `conversation-bump .32s var(--c-ease)` | [css/conversation.css:1547](../public/css/conversation.css) |
| `wi-comet var(--wi-t) linear infinite` | [css/conversation.css:1605](../public/css/conversation.css) |
| `wi-settle 1.2s ease-out` | [css/conversation.css:1617](../public/css/conversation.css) |
| `wi-dot-settle 1.2s ease-out` | [css/conversation.css:1618](../public/css/conversation.css) |

### `background`（112种）

| 实际值 | 首个来源 |
|---|---|
| `var(--bg)` | [css/style.css:31](../public/css/style.css) |
| `var(--nav-bg)` | [css/style.css:52](../public/css/style.css) |
| `var(--bg-secondary)` | [css/style.css:88](../public/css/style.css) |
| `var(--text-muted)` | [css/style.css:101](../public/css/style.css) |
| `rgba(5, 150, 105, 0.08)` | [css/style.css:108](../public/css/style.css) |
| `var(--green)` | [css/style.css:110](../public/css/style.css) |
| `rgba(234, 88, 12, 0.08)` | [css/style.css:115](../public/css/style.css) |
| `var(--state-possibly-stuck)` | [css/style.css:117](../public/css/style.css) |
| `rgba(13, 148, 136, 0.06)` | [css/style.css:122](../public/css/style.css) |
| `var(--accent)` | [css/style.css:124](../public/css/style.css) |
| `transparent` | [css/style.css:167](../public/css/style.css) |
| `rgba(0, 0, 0, 0.02)` | [css/style.css:187](../public/css/style.css) |
| `var(--bg-elevated)` | [css/style.css:266](../public/css/style.css) |
| `rgba(13, 148, 136, 0.12)` | [css/style.css:267](../public/css/style.css) |
| `var(--c-primary)` | [css/style.css:339](../public/css/style.css) |
| `color-mix(in srgb, #ef4444 12%, transparent)` | [css/style.css:447](../public/css/style.css) |
| `color-mix(in srgb, #22c55e 12%, transparent)` | [css/style.css:448](../public/css/style.css) |
| `color-mix(in srgb, #f59e0b 14%, transparent)` | [css/style.css:449](../public/css/style.css) |
| `none` | [css/style.css:506](../public/css/style.css) |
| `var(--state-busy, #d97706)` | [css/style.css:676](../public/css/style.css) |
| `var(--state-idle, #16a34a)` | [css/style.css:677](../public/css/style.css) |
| `var(--state-stuck, #ef4444)` | [css/style.css:678](../public/css/style.css) |
| `color-mix(in srgb, var(--link-color, var(--text-muted)) 12%, transparent)` | [css/style.css:715](../public/css/style.css) |
| `color-mix(in srgb, var(--green) 16%, transparent)` | [css/style.css:737](../public/css/style.css) |
| `color-mix(in srgb, var(--text-muted) 14%, transparent)` | [css/style.css:752](../public/css/style.css) |
| `var(--bg-card)` | [css/style.css:776](../public/css/style.css) |
| `rgba(100, 116, 139, 0.04)` | [css/style.css:828](../public/css/style.css) |
| `var(--bg-code)` | [css/style.css:853](../public/css/style.css) |
| `#f59e0b` | [css/style.css:988](../public/css/style.css) |
| `var(--bg-primary)` | [css/style.css:1036](../public/css/style.css) |
| `rgba(34, 197, 94, .06)` | [css/style.css:1056](../public/css/style.css) |
| `rgba(239, 68, 68, .06)` | [css/style.css:1057](../public/css/style.css) |
| `#0a0f14` | [css/style.css:1058](../public/css/style.css) |
| `var(--wb-panel)` | [css/wb.css:141](../public/css/wb.css) |
| `var(--wb-hover)` | [css/wb.css:142](../public/css/wb.css) |
| `var(--c-primary-hover)` | [css/wb.css:147](../public/css/wb.css) |
| `var(--c-primary-press)` | [css/wb.css:148](../public/css/wb.css) |
| `var(--c-danger)` | [css/wb.css:150](../public/css/wb.css) |
| `var(--c-danger-hover)` | [css/wb.css:151](../public/css/wb.css) |
| `var(--c-danger-press)` | [css/wb.css:152](../public/css/wb.css) |
| `currentColor` | [css/wb.css:163](../public/css/wb.css) |
| `var(--wb-line-strong)` | [css/wb.css:205](../public/css/wb.css) |
| `var(--wb-work)` | [css/wb.css:241](../public/css/wb.css) |
| `var(--wb-err)` | [css/wb.css:242](../public/css/wb.css) |
| `var(--wb-wait)` | [css/wb.css:243](../public/css/wb.css) |
| `var(--wb-off)` | [css/wb.css:244](../public/css/wb.css) |
| `var(--text-dim)` | [css/wb.css:245](../public/css/wb.css) |
| `color-mix(in srgb, var(--text) 22%, transparent)` | [css/wb.css:254](../public/css/wb.css) |
| `var(--wb-accent-soft)` | [css/wb.css:313](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-side) 70%, var(--bg))` | [css/wb.css:315](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-work) 13%, transparent)` | [css/wb.css:329](../public/css/wb.css) |
| `var(--wb-idle)` | [css/wb.css:332](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-wait) 15%, transparent)` | [css/wb.css:333](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-err) 12%, transparent)` | [css/wb.css:335](../public/css/wb.css) |
| `radial-gradient(circle, var(--bg) 62%, transparent 64%), conic-gradient(var(--text-dim) var(--context), var(--wb-off) 0)` | [css/wb.css:353](../public/css/wb.css) |
| `radial-gradient(circle, var(--bg) 62%, transparent 64%), conic-gradient(var(--wb-wait) var(--context), var(--wb-off) 0)` | [css/wb.css:354](../public/css/wb.css) |
| `var(--wb-side)` | [css/wb.css:393](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-wait) 5%, var(--wb-panel))` | [css/wb.css:429](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-err) 5%, var(--wb-panel))` | [css/wb.css:430](../public/css/wb.css) |
| `color-mix(in srgb, var(--text-dim) 13%, transparent)` | [css/wb.css:533](../public/css/wb.css) |
| `var(--wb-scrim)` | [css/wb.css:543](../public/css/wb.css) |
| `conic-gradient(var(--wb-work) 0 var(--ok), var(--wb-wait) var(--ok) var(--late), var(--wb-err) var(--late) 100%)` | [css/wb.css:649](../public/css/wb.css) |
| `linear-gradient(var(--wb-line), var(--wb-line)) 0 25% / 100% 1px no-repeat, linear-gradient(var(--wb-line), var(--wb-line)) 0 50% / 100% 1px no-repeat` | [css/wb.css:660](../public/css/wb.css) |
| `var(--wb-line)` | [css/wb.css:670](../public/css/wb.css) |
| `var(--text)` | [css/wb.css:678](../public/css/wb.css) |
| `color-mix(in srgb, var(--text) 18%, transparent)` | [css/wb.css:718](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-wait) 16%, transparent)` | [css/wb.css:886](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-wait) 8%, transparent)` | [css/wb.css:948](../public/css/wb.css) |
| `var(--bg-card,var(--bg))` | [css/wb.css:1075](../public/css/wb.css) |
| `var(--bg-elevated,var(--bg))` | [css/wb.css:1078](../public/css/wb.css) |
| `var(--danger,#c54b4b)` | [css/wb.css:1113](../public/css/wb.css) |
| `linear-gradient(to right, var(--wb-side) 0 208px, var(--wb-line) 208px 209px, transparent 209px)` | [css/wb.css:1145](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-work) 40%, var(--text))` | [css/wb.css:1209](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-err) 8%, transparent)` | [css/wb.css:1257](../public/css/wb.css) |
| `color-mix(in srgb, var(--bg) 92%, transparent)` | [css/wb.css:1259](../public/css/wb.css) |
| `color-mix(in srgb, var(--text) 35%, transparent)` | [css/wb.css:1331](../public/css/wb.css) |
| `var(--wb-quota-fill, var(--accent))` | [css/wb.css:1380](../public/css/wb.css) |
| `var(--wb-dot)` | [css/wb.css:1502](../public/css/wb.css) |
| `var(--c-raised)` | [css/wb.css:1572](../public/css/wb.css) |
| `#fff` | [css/wb.css:1586](../public/css/wb.css) |
| `var(--c-sunken)` | [css/wb.css:1605](../public/css/wb.css) |
| `var(--c-fill-hover)` | [css/wb.css:1617](../public/css/wb.css) |
| `color-mix(in srgb,var(--wb-wait) 8%,var(--wb-panel))` | [css/conversation.css:794](../public/css/conversation.css) |
| `var(--wb-hover, var(--wb-line))` | [css/conversation.css:956](../public/css/conversation.css) |
| `var(--conversation-internal-bg)` | [css/conversation.css:1032](../public/css/conversation.css) |
| `var(--c-surface)` | [css/conversation.css:1083](../public/css/conversation.css) |
| `var(--c-fill)` | [css/conversation.css:1145](../public/css/conversation.css) |
| `var(--c-ink-meta)` | [css/conversation.css:1149](../public/css/conversation.css) |
| `var(--c-accent-soft)` | [css/conversation.css:1151](../public/css/conversation.css) |
| `var(--c-success-soft)` | [css/conversation.css:1155](../public/css/conversation.css) |
| `color-mix(in srgb, var(--text) 4%, var(--c-surface))` | [css/conversation.css:1186](../public/css/conversation.css) |
| `color-mix(in srgb, var(--text) 8%, var(--c-surface))` | [css/conversation.css:1191](../public/css/conversation.css) |
| `radial-gradient(circle, var(--c-primary) 0 3.5px, var(--c-surface) 4px)` | [css/conversation.css:1227](../public/css/conversation.css) |
| `var(--c-on-fill)` | [css/conversation.css:1231](../public/css/conversation.css) |
| `var(--c-fill-press)` | [css/conversation.css:1254](../public/css/conversation.css) |
| `color-mix(in srgb, var(--text) 25%, transparent)` | [css/conversation.css:1265](../public/css/conversation.css) |
| `var(--c-success-ink)` | [css/conversation.css:1278](../public/css/conversation.css) |
| `var(--c-input-bg)` | [css/conversation.css:1292](../public/css/conversation.css) |
| `var(--c-danger-soft)` | [css/conversation.css:1361](../public/css/conversation.css) |
| `var(--c-danger-ink)` | [css/conversation.css:1364](../public/css/conversation.css) |
| `color-mix(in srgb,var(--text) 5%,transparent)` | [css/conversation.css:1510](../public/css/conversation.css) |
| `color-mix(in srgb,var(--text) 8%,transparent)` | [css/conversation.css:1511](../public/css/conversation.css) |
| `color-mix(in srgb,var(--text) 4%,var(--wb-panel))` | [css/conversation.css:1524](../public/css/conversation.css) |
| `color-mix(in srgb,var(--accent) 15%,transparent)` | [css/conversation.css:1544](../public/css/conversation.css) |
| `color-mix(in srgb,var(--wb-work) 11%,transparent)` | [css/conversation.css:1597](../public/css/conversation.css) |
| `color-mix(in srgb,var(--wb-work) 18%,transparent)` | [css/conversation.css:1598](../public/css/conversation.css) |
| `color-mix(in srgb,var(--wb-work) 16%,transparent)` | [css/conversation.css:1619](../public/css/conversation.css) |
| `color-mix(in srgb,var(--wb-work) 9%,transparent)` | [css/conversation.css:1625](../public/css/conversation.css) |
| `var(--accent-dim)` | [css/conversation.css:1659](../public/css/conversation.css) |
| `var(--state-busy)` | [css/conversation.css:1679](../public/css/conversation.css) |
| `var(--state-idle)` | [css/conversation.css:1680](../public/css/conversation.css) |
| `color-mix(in srgb,var(--state-busy) 10%,transparent)` | [css/conversation.css:1687](../public/css/conversation.css) |

### `background-color`（1种）

| 实际值 | 首个来源 |
|---|---|
| `color-mix(in srgb,var(--wb-wait) 34%,transparent)` | [css/conversation.css:1522](../public/css/conversation.css) |

### `border`（25种）

| 实际值 | 首个来源 |
|---|---|
| `1px solid var(--border)` | [css/style.css:87](../public/css/style.css) |
| `none` | [css/style.css:165](../public/css/style.css) |
| `0` | [css/style.css:258](../public/css/style.css) |
| `1px solid color-mix(in srgb, #f59e0b 40%, var(--border))` | [css/style.css:405](../public/css/style.css) |
| `1px solid color-mix(in srgb, var(--link-color, var(--text-muted)) 44%, var(--border))` | [css/style.css:714](../public/css/style.css) |
| `1px solid var(--border-focus)` | [css/style.css:934](../public/css/style.css) |
| `1px solid #253140` | [css/style.css:1058](../public/css/style.css) |
| `1px solid var(--wb-line-strong)` | [css/wb.css:141](../public/css/wb.css) |
| `1px solid transparent` | [css/wb.css:154](../public/css/wb.css) |
| `1.5px solid var(--text-muted)` | [css/wb.css:338](../public/css/wb.css) |
| `1px dashed var(--wb-line-strong)` | [css/wb.css:339](../public/css/wb.css) |
| `1.5px dashed var(--text-muted)` | [css/wb.css:340](../public/css/wb.css) |
| `1px solid var(--wb-line)` | [css/wb.css:440](../public/css/wb.css) |
| `1px solid var(--border, #ddd)` | [css/wb.css:554](../public/css/wb.css) |
| `2px solid var(--wb-panel)` | [css/wb.css:671](../public/css/wb.css) |
| `1px solid color-mix(in srgb, var(--wb-err) 30%, transparent)` | [css/wb.css:747](../public/css/wb.css) |
| `1px solid color-mix(in srgb, var(--wb-wait) 45%, transparent)` | [css/wb.css:933](../public/css/wb.css) |
| `1px solid var(--wb-accent-line)` | [css/wb.css:947](../public/css/wb.css) |
| `10px solid transparent` | [css/wb.css:1495](../public/css/wb.css) |
| `1px solid color-mix(in srgb,var(--wb-wait) 30%,var(--wb-line))` | [css/conversation.css:137](../public/css/conversation.css) |
| `1px solid color-mix(in srgb,var(--wb-wait) 35%,var(--wb-line))` | [css/conversation.css:792](../public/css/conversation.css) |
| `1.5px solid var(--c-control-edge)` | [css/conversation.css:1222](../public/css/conversation.css) |
| `1px solid var(--c-line-input)` | [css/conversation.css:1291](../public/css/conversation.css) |
| `1px solid CanvasText` | [css/conversation.css:1473](../public/css/conversation.css) |
| `1px solid color-mix(in srgb,var(--wb-work) 24%,transparent)` | [css/conversation.css:1690](../public/css/conversation.css) |

### `border-bottom`（5种）

| 实际值 | 首个来源 |
|---|---|
| `1px solid var(--border)` | [css/style.css:53](../public/css/style.css) |
| `1px solid var(--wb-line)` | [css/wb.css:183](../public/css/wb.css) |
| `1px solid var(--wb-line-strong)` | [css/wb.css:662](../public/css/wb.css) |
| `2px solid transparent` | [css/wb.css:1274](../public/css/wb.css) |
| `0` | [css/wb.css:1282](../public/css/wb.css) |

### `border-bottom-color`（3种）

| 实际值 | 首个来源 |
|---|---|
| `var(--wb-line-strong)` | [css/wb.css:315](../public/css/wb.css) |
| `var(--accent)` | [css/wb.css:419](../public/css/wb.css) |
| `var(--text)` | [css/wb.css:1276](../public/css/wb.css) |

### `border-color`（27种）

| 实际值 | 首个来源 |
|---|---|
| `rgba(5, 150, 105, 0.2)` | [css/style.css:107](../public/css/style.css) |
| `rgba(234, 88, 12, 0.2)` | [css/style.css:114](../public/css/style.css) |
| `rgba(13, 148, 136, 0.2)` | [css/style.css:121](../public/css/style.css) |
| `var(--c-primary)` | [css/style.css:338](../public/css/style.css) |
| `color-mix(in srgb, #f59e0b 40%, var(--border))` | [css/style.css:390](../public/css/style.css) |
| `var(--border-focus)` | [css/style.css:634](../public/css/style.css) |
| `var(--border)` | [css/style.css:793](../public/css/style.css) |
| `rgba(34, 197, 94, .35)` | [css/style.css:1056](../public/css/style.css) |
| `rgba(239, 68, 68, .35)` | [css/style.css:1057](../public/css/style.css) |
| `var(--c-primary-hover)` | [css/wb.css:147](../public/css/wb.css) |
| `var(--c-primary-press)` | [css/wb.css:148](../public/css/wb.css) |
| `var(--c-danger)` | [css/wb.css:150](../public/css/wb.css) |
| `var(--c-danger-hover)` | [css/wb.css:151](../public/css/wb.css) |
| `var(--c-danger-press)` | [css/wb.css:152](../public/css/wb.css) |
| `var(--accent)` | [css/wb.css:166](../public/css/wb.css) |
| `transparent` | [css/wb.css:200](../public/css/wb.css) |
| `var(--wb-line-strong)` | [css/wb.css:337](../public/css/wb.css) |
| `var(--text-muted)` | [css/wb.css:457](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-err) 45%, transparent)` | [css/wb.css:459](../public/css/wb.css) |
| `var(--wb-accent-line)` | [css/wb.css:494](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-wait) 40%, transparent)` | [css/wb.css:948](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-err) 40%, transparent)` | [css/wb.css:1318](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-err) 40%, var(--wb-line-strong))` | [css/wb.css:1356](../public/css/wb.css) |
| `var(--c-ink-2)` | [css/conversation.css:1252](../public/css/conversation.css) |
| `var(--c-line-input-hover)` | [css/conversation.css:1300](../public/css/conversation.css) |
| `var(--c-danger-ink)` | [css/conversation.css:1305](../public/css/conversation.css) |
| `color-mix(in srgb,var(--wb-work) 24%,transparent)` | [css/conversation.css:1597](../public/css/conversation.css) |

### `border-inline-start`（2种）

| 实际值 | 首个来源 |
|---|---|
| `3px solid var(--accent)` | [css/wb.css:1086](../public/css/wb.css) |
| `3px solid var(--danger,#c54b4b)` | [css/wb.css:1095](../public/css/wb.css) |

### `border-left`（12种）

| 实际值 | 首个来源 |
|---|---|
| `3px solid var(--border)` | [css/style.css:512](../public/css/style.css) |
| `2px solid rgba(100, 116, 139, 0.3)` | [css/style.css:827](../public/css/style.css) |
| `3px solid #4e8de8` | [css/style.css:1104](../public/css/style.css) |
| `3px solid #31a772` | [css/style.css:1105](../public/css/style.css) |
| `1px solid var(--wb-line)` | [css/wb.css:236](../public/css/wb.css) |
| `3px solid var(--wb-err)` | [css/wb.css:265](../public/css/wb.css) |
| `3px solid var(--wb-work)` | [css/wb.css:428](../public/css/wb.css) |
| `3px solid var(--wb-wait)` | [css/wb.css:429](../public/css/wb.css) |
| `0` | [css/wb.css:557](../public/css/wb.css) |
| `1.5px dashed var(--text-muted)` | [css/wb.css:871](../public/css/wb.css) |
| `3px solid var(--accent)` | [css/conversation.css:1502](../public/css/conversation.css) |
| `3px solid color-mix(in srgb,var(--wb-wait) 70%,transparent)` | [css/conversation.css:1535](../public/css/conversation.css) |

### `border-left-color`（2种）

| 实际值 | 首个来源 |
|---|---|
| `var(--wb-wait)` | [css/wb.css:268](../public/css/wb.css) |
| `var(--wb-line-strong)` | [css/conversation.css:1512](../public/css/conversation.css) |

### `border-radius`（38种）

| 实际值 | 首个来源 |
|---|---|
| `999px` | [css/style.css:86](../public/css/style.css) |
| `50%` | [css/style.css:100](../public/css/style.css) |
| `var(--radius-sm) var(--radius-sm) 0 0` | [css/style.css:166](../public/css/style.css) |
| `1px` | [css/style.css:183](../public/css/style.css) |
| `var(--radius-sm)` | [css/style.css:213](../public/css/style.css) |
| `var(--radius-xs)` | [css/style.css:313](../public/css/style.css) |
| `var(--radius)` | [css/style.css:778](../public/css/style.css) |
| `0 var(--radius-sm) var(--radius-sm) 0` | [css/style.css:829](../public/css/style.css) |
| `6px` | [css/style.css:1084](../public/css/style.css) |
| `8px` | [css/style.css:1100](../public/css/style.css) |
| `var(--wb-r)` | [css/wb.css:141](../public/css/wb.css) |
| `5px` | [css/wb.css:171](../public/css/wb.css) |
| `3px` | [css/wb.css:244](../public/css/wb.css) |
| `20px` | [css/wb.css:327](../public/css/wb.css) |
| `12px` | [css/wb.css:427](../public/css/wb.css) |
| `13px` | [css/wb.css:493](../public/css/wb.css) |
| `14px` | [css/wb.css:507](../public/css/wb.css) |
| `0` | [css/wb.css:578](../public/css/wb.css) |
| `3px 3px 1px 1px` | [css/wb.css:663](../public/css/wb.css) |
| `4px` | [css/wb.css:672](../public/css/wb.css) |
| `2px` | [css/wb.css:716](../public/css/wb.css) |
| `2px 2px 0 0` | [css/wb.css:718](../public/css/wb.css) |
| `10px` | [css/wb.css:750](../public/css/wb.css) |
| `3px 0 0 3px` | [css/wb.css:868](../public/css/wb.css) |
| `0 3px 3px 0` | [css/wb.css:870](../public/css/wb.css) |
| `9px` | [css/wb.css:885](../public/css/wb.css) |
| `7px` | [css/wb.css:1078](../public/css/wb.css) |
| `16px 16px 0 0` | [css/wb.css:1572](../public/css/wb.css) |
| `var(--wb-segment-radius)` | [css/wb.css:1604](../public/css/wb.css) |
| `calc(var(--wb-segment-radius) - 2px)` | [css/wb.css:1610](../public/css/wb.css) |
| `11px` | [css/conversation.css:369](../public/css/conversation.css) |
| `18px` | [css/conversation.css:454](../public/css/conversation.css) |
| `var(--c-r-lg)` | [css/conversation.css:1083](../public/css/conversation.css) |
| `var(--c-r)` | [css/conversation.css:1168](../public/css/conversation.css) |
| `var(--c-r-sm)` | [css/conversation.css:1328](../public/css/conversation.css) |
| `0 6px 6px 0` | [css/conversation.css:1535](../public/css/conversation.css) |
| `14px 14px 0 0` | [css/conversation.css:1554](../public/css/conversation.css) |
| `22px` | [css/conversation.css:1706](../public/css/conversation.css) |

### `border-right`（2种）

| 实际值 | 首个来源 |
|---|---|
| `1px solid var(--wb-line)` | [css/wb.css:481](../public/css/wb.css) |
| `0` | [css/wb.css:482](../public/css/wb.css) |

### `border-style`（1种）

| 实际值 | 首个来源 |
|---|---|
| `dashed` | [css/style.css:1106](../public/css/style.css) |

### `border-top`（7种）

| 实际值 | 首个来源 |
|---|---|
| `1px solid var(--border)` | [css/style.css:518](../public/css/style.css) |
| `1px solid var(--wb-line)` | [css/wb.css:447](../public/css/wb.css) |
| `1px dashed var(--wb-line-strong)` | [css/wb.css:475](../public/css/wb.css) |
| `1.5px solid var(--text-dim)` | [css/wb.css:533](../public/css/wb.css) |
| `1px dashed color-mix(in srgb, var(--text-dim) 55%, transparent)` | [css/wb.css:534](../public/css/wb.css) |
| `0` | [css/wb.css:894](../public/css/wb.css) |
| `1px solid var(--c-line)` | [css/conversation.css:1386](../public/css/conversation.css) |

### `bottom`（8种）

| 实际值 | 首个来源 |
|---|---|
| `0` | [css/style.css:179](../public/css/style.css) |
| `6px` | [css/style.css:734](../public/css/style.css) |
| `16px` | [css/style.css:1118](../public/css/style.css) |
| `14px` | [css/wb.css:507](../public/css/wb.css) |
| `-4px` | [css/wb.css:871](../public/css/wb.css) |
| `12px` | [css/conversation.css:451](../public/css/conversation.css) |
| `0!important` | [css/conversation.css:1554](../public/css/conversation.css) |
| `-11px` | [css/conversation.css:1694](../public/css/conversation.css) |

### `box-shadow`（39种）

| 实际值 | 首个来源 |
|---|---|
| `var(--shadow-card)` | [css/style.css:779](../public/css/style.css) |
| `var(--shadow-card-hover)` | [css/style.css:784](../public/css/style.css) |
| `0 4px 16px rgba(0, 0, 0, 0.15)` | [css/style.css:805](../public/css/style.css) |
| `0 0 0 4px rgba(37, 99, 235, 0.15)` | [css/style.css:814](../public/css/style.css) |
| `0 0 0 8px rgba(37, 99, 235, 0.06)` | [css/style.css:815](../public/css/style.css) |
| `0 8px 32px rgba(0, 0, 0, 0.2)` | [css/style.css:872](../public/css/style.css) |
| `0 12px 32px rgba(10, 15, 20, .16)` | [css/style.css:1058](../public/css/style.css) |
| `var(--c-focus)` | [css/wb.css:149](../public/css/wb.css) |
| `0 0 0 2px var(--c-surface), 0 0 0 4px var(--c-danger)` | [css/wb.css:153](../public/css/wb.css) |
| `var(--wb-quota-outline)` | [css/wb.css:246](../public/css/wb.css) |
| `var(--wb-shadow)` | [css/wb.css:393](../public/css/wb.css) |
| `var(--wb-shadow), 0 0 0 100vmax var(--wb-scrim)` | [css/wb.css:548](../public/css/wb.css) |
| `none` | [css/wb.css:557](../public/css/wb.css) |
| `inset 0 -2px 0 transparent` | [css/wb.css:578](../public/css/wb.css) |
| `inset 0 -2px 0 var(--accent)` | [css/wb.css:579](../public/css/wb.css) |
| `0 0 0 3px var(--wb-accent-soft)` | [css/wb.css:680](../public/css/wb.css) |
| `inset 3px 0 var(--accent)` | [css/wb.css:919](../public/css/wb.css) |
| `inset 3px 0 0 var(--accent)` | [css/wb.css:1357](../public/css/wb.css) |
| `var(--wb-dot-ring)` | [css/wb.css:1502](../public/css/wb.css) |
| `var(--c-shadow-thumb)` | [css/wb.css:1623](../public/css/wb.css) |
| `0 1px 2px color-mix(in srgb,var(--text) 3%,transparent)` | [css/conversation.css:95](../public/css/conversation.css) |
| `var(--c-shadow-card)` | [css/conversation.css:1083](../public/css/conversation.css) |
| `var(--c-shadow-btn)` | [css/conversation.css:1169](../public/css/conversation.css) |
| `var(--c-shadow-btn), var(--c-focus)` | [css/conversation.css:1175](../public/css/conversation.css) |
| `var(--c-shadow-fill)` | [css/conversation.css:1179](../public/css/conversation.css) |
| `var(--c-shadow-fill), var(--c-focus)` | [css/conversation.css:1181](../public/css/conversation.css) |
| `var(--c-shadow-fill), 0 0 0 2px var(--c-surface), 0 0 0 4px color-mix(in srgb, var(--wb-err) 70%, transparent)` | [css/conversation.css:1184](../public/css/conversation.css) |
| `inset 0 0 0 1px transparent` | [css/conversation.css:1243](../public/css/conversation.css) |
| `inset 0 0 0 1px var(--c-line)` | [css/conversation.css:1251](../public/css/conversation.css) |
| `inset 0 0 0 1px var(--c-accent-line)` | [css/conversation.css:1255](../public/css/conversation.css) |
| `inset 0 0 0 1px var(--c-accent-line), var(--c-focus)` | [css/conversation.css:1256](../public/css/conversation.css) |
| `var(--c-shadow-xs)` | [css/conversation.css:1292](../public/css/conversation.css) |
| `0 0 0 3px var(--c-accent-halo)` | [css/conversation.css:1303](../public/css/conversation.css) |
| `0 0 0 3px var(--c-danger-soft)` | [css/conversation.css:1306](../public/css/conversation.css) |
| `inset 0 0 0 1px var(--c-danger-line)` | [css/conversation.css:1361](../public/css/conversation.css) |
| `0 0 0 2px var(--accent)` | [css/conversation.css:1518](../public/css/conversation.css) |
| `0 0 0 2px transparent` | [css/conversation.css:1518](../public/css/conversation.css) |
| `var(--c-shadow-card),0 12px 32px color-mix(in srgb,var(--text) 12%,transparent)` | [css/conversation.css:1527](../public/css/conversation.css) |
| `0 0 0 2px var(--wb-panel)` | [css/conversation.css:1553](../public/css/conversation.css) |

### `color`（35种）

| 实际值 | 首个来源 |
|---|---|
| `var(--text)` | [css/style.css:32](../public/css/style.css) |
| `var(--accent)` | [css/style.css:66](../public/css/style.css) |
| `var(--text-dim)` | [css/style.css:89](../public/css/style.css) |
| `var(--green)` | [css/style.css:106](../public/css/style.css) |
| `var(--state-possibly-stuck)` | [css/style.css:113](../public/css/style.css) |
| `var(--text-muted)` | [css/style.css:155](../public/css/style.css) |
| `var(--c-on-fill)` | [css/style.css:340](../public/css/style.css) |
| `var(--link-color, var(--text-dim))` | [css/style.css:716](../public/css/style.css) |
| `var(--green, #059669)` | [css/style.css:1007](../public/css/style.css) |
| `#ef4444` | [css/style.css:1008](../public/css/style.css) |
| `var(--text-secondary)` | [css/style.css:1032](../public/css/style.css) |
| `var(--text-primary)` | [css/style.css:1036](../public/css/style.css) |
| `#22c55e` | [css/style.css:1048](../public/css/style.css) |
| `#15803d` | [css/style.css:1056](../public/css/style.css) |
| `#b91c1c` | [css/style.css:1057](../public/css/style.css) |
| `var(--wb-wait)` | [css/wb.css:137](../public/css/wb.css) |
| `var(--wb-err)` | [css/wb.css:138](../public/css/wb.css) |
| `var(--wb-work)` | [css/wb.css:264](../public/css/wb.css) |
| `inherit` | [css/wb.css:310](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-work) 65%, var(--text))` | [css/wb.css:329](../public/css/wb.css) |
| `color-mix(in srgb, var(--wb-wait) 70%, var(--text))` | [css/wb.css:333](../public/css/wb.css) |
| `var(--wb-quota-color, var(--text))` | [css/wb.css:1382](../public/css/wb.css) |
| `var(--c-ink-2)` | [css/wb.css:1612](../public/css/wb.css) |
| `var(--c-ink)` | [css/wb.css:1618](../public/css/wb.css) |
| `var(--danger,#b42318)` | [css/conversation.css:994](../public/css/conversation.css) |
| `#fff` | [css/conversation.css:1016](../public/css/conversation.css) |
| `var(--c-ink-meta)` | [css/conversation.css:1091](../public/css/conversation.css) |
| `var(--c-accent-ink)` | [css/conversation.css:1151](../public/css/conversation.css) |
| `var(--c-success-ink)` | [css/conversation.css:1155](../public/css/conversation.css) |
| `var(--c-danger-ink)` | [css/conversation.css:1288](../public/css/conversation.css) |
| `var(--accent-hover)` | [css/conversation.css:1490](../public/css/conversation.css) |
| `var(--wb-on-fill)` | [css/conversation.css:1501](../public/css/conversation.css) |
| `color-mix(in srgb,var(--wb-work) 68%,var(--text))` | [css/conversation.css:1597](../public/css/conversation.css) |
| `color-mix(in srgb,var(--wb-work) 60%,var(--text))` | [css/conversation.css:1598](../public/css/conversation.css) |
| `var(--state-busy)` | [css/conversation.css:1687](../public/css/conversation.css) |

### `column-gap`（6种）

| 实际值 | 首个来源 |
|---|---|
| `6px` | [css/wb.css:213](../public/css/wb.css) |
| `14px` | [css/wb.css:276](../public/css/wb.css) |
| `12px` | [css/wb.css:284](../public/css/wb.css) |
| `0` | [css/wb.css:568](../public/css/wb.css) |
| `8px` | [css/wb.css:609](../public/css/wb.css) |
| `16px` | [css/wb.css:699](../public/css/wb.css) |

### `content`（5种）

| 实际值 | 首个来源 |
|---|---|
| `""` | [css/style.css:97](../public/css/style.css) |
| `''` | [css/style.css:981](../public/css/style.css) |
| `"· "` | [css/wb.css:189](../public/css/wb.css) |
| `"·"` | [css/wb.css:855](../public/css/wb.css) |
| `none` | [css/wb.css:979](../public/css/wb.css) |

### `cursor`（4种）

| 实际值 | 首个来源 |
|---|---|
| `pointer` | [css/style.css:171](../public/css/style.css) |
| `not-allowed` | [css/style.css:193](../public/css/style.css) |
| `text` | [css/wb.css:303](../public/css/wb.css) |
| `default` | [css/wb.css:864](../public/css/wb.css) |

### `display`（13种）

| 实际值 | 首个来源 |
|---|---|
| `flex` | [css/style.css:44](../public/css/style.css) |
| `inline-flex` | [css/style.css:81](../public/css/style.css) |
| `none` | [css/style.css:199](../public/css/style.css) |
| `grid` | [css/style.css:203](../public/css/style.css) |
| `block` | [css/style.css:584](../public/css/style.css) |
| `inline-block` | [css/style.css:671](../public/css/style.css) |
| `none!important` | [css/wb.css:231](../public/css/wb.css) |
| `inline-grid` | [css/wb.css:352](../public/css/wb.css) |
| `none !important` | [css/wb.css:385](../public/css/wb.css) |
| `contents` | [css/wb.css:401](../public/css/wb.css) |
| `inline` | [css/wb.css:562](../public/css/wb.css) |
| `-webkit-box` | [css/wb.css:619](../public/css/wb.css) |
| `inline-flex !important` | [css/wb.css:1046](../public/css/wb.css) |

### `flex`（18种）

| 实际值 | 首个来源 |
|---|---|
| `1` | [css/style.css:360](../public/css/style.css) |
| `none` | [css/style.css:710](../public/css/style.css) |
| `0 0 auto` | [css/style.css:898](../public/css/style.css) |
| `0 0 32px` | [css/style.css:919](../public/css/style.css) |
| `1 1 250px` | [css/style.css:1094](../public/css/style.css) |
| `1 1 0` | [css/style.css:1095](../public/css/style.css) |
| `1 1 220px` | [css/style.css:1099](../public/css/style.css) |
| `0 1 auto` | [css/wb.css:214](../public/css/wb.css) |
| `0 0 100%` | [css/wb.css:215](../public/css/wb.css) |
| `0 1 150px` | [css/wb.css:282](../public/css/wb.css) |
| `1 1 auto` | [css/wb.css:345](../public/css/wb.css) |
| `1 1 100%` | [css/wb.css:386](../public/css/wb.css) |
| `1 1 180px` | [css/wb.css:413](../public/css/wb.css) |
| `1 0 auto` | [css/wb.css:820](../public/css/wb.css) |
| `1 1 140px` | [css/wb.css:821](../public/css/wb.css) |
| `0 0 132px` | [css/wb.css:906](../public/css/wb.css) |
| `1 1 240px` | [css/wb.css:1080](../public/css/wb.css) |
| `0 1 280px` | [css/wb.css:1185](../public/css/wb.css) |

### `flex-basis`（1种）

| 实际值 | 首个来源 |
|---|---|
| `100%` | [css/style.css:1123](../public/css/style.css) |

### `flex-direction`（3种）

| 实际值 | 首个来源 |
|---|---|
| `column` | [css/style.css:289](../public/css/style.css) |
| `row` | [css/wb.css:183](../public/css/wb.css) |
| `row-reverse` | [css/wb.css:372](../public/css/wb.css) |

### `font`（2种）

| 实际值 | 首个来源 |
|---|---|
| `inherit` | [css/style.css:36](../public/css/style.css) |
| `12px/1.6 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"PingFang SC","Noto Sans CJK SC",monospace` | [css/conversation.css:1579](../public/css/conversation.css) |

### `font-family`（7种）

| 实际值 | 首个来源 |
|---|---|
| `Inter` | [css/style.css:3](../public/css/style.css) |
| `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif` | [css/style.css:20](../public/css/style.css) |
| `"JetBrains Mono", monospace` | [css/style.css:375](../public/css/style.css) |
| `"JetBrains Mono", ui-monospace, monospace` | [css/style.css:700](../public/css/style.css) |
| `var(--font-mono)` | [css/style.css:946](../public/css/style.css) |
| `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | [css/wb.css:134](../public/css/wb.css) |
| `inherit` | [css/wb.css:394](../public/css/wb.css) |

### `font-size`（22种）

| 实际值 | 首个来源 |
|---|---|
| `14px` | [css/style.css:21](../public/css/style.css) |
| `20px` | [css/style.css:39](../public/css/style.css) |
| `15px` | [css/style.css:40](../public/css/style.css) |
| `11px` | [css/style.css:67](../public/css/style.css) |
| `12px` | [css/style.css:156](../public/css/style.css) |
| `13px` | [css/style.css:169](../public/css/style.css) |
| `0.92em` | [css/style.css:502](../public/css/style.css) |
| `inherit` | [css/style.css:507](../public/css/style.css) |
| `10px` | [css/style.css:696](../public/css/style.css) |
| `18px` | [css/style.css:883](../public/css/style.css) |
| `16px` | [css/style.css:1043](../public/css/style.css) |
| `12.5px` | [css/wb.css:141](../public/css/wb.css) |
| `11.5px` | [css/wb.css:291](../public/css/wb.css) |
| `10.5px` | [css/wb.css:352](../public/css/wb.css) |
| `13.5px` | [css/wb.css:546](../public/css/wb.css) |
| `19px` | [css/wb.css:652](../public/css/wb.css) |
| `17px` | [css/wb.css:816](../public/css/wb.css) |
| `14.5px` | [css/wb.css:1359](../public/css/wb.css) |
| `0` | [css/conversation.css:540](../public/css/conversation.css) |
| `9.5px` | [css/conversation.css:617](../public/css/conversation.css) |
| `9px` | [css/conversation.css:624](../public/css/conversation.css) |
| `var(--c-input-fs)` | [css/conversation.css:1293](../public/css/conversation.css) |

### `font-weight`（8种）

| 实际值 | 首个来源 |
|---|---|
| `100 900` | [css/style.css:5](../public/css/style.css) |
| `600` | [css/style.css:39](../public/css/style.css) |
| `700` | [css/style.css:68](../public/css/style.css) |
| `500` | [css/style.css:170](../public/css/style.css) |
| `400` | [css/style.css:668](../public/css/style.css) |
| `550` | [css/wb.css:141](../public/css/wb.css) |
| `650` | [css/wb.css:185](../public/css/wb.css) |
| `450` | [css/wb.css:328](../public/css/wb.css) |

### `gap`（43种）

| 实际值 | 首个来源 |
|---|---|
| `var(--space-md)` | [css/style.css:47](../public/css/style.css) |
| `var(--space-sm)` | [css/style.css:61](../public/css/style.css) |
| `6px` | [css/style.css:83](../public/css/style.css) |
| `2px` | [css/style.css:145](../public/css/style.css) |
| `var(--space-xs)` | [css/style.css:297](../public/css/style.css) |
| `4px` | [css/style.css:411](../public/css/style.css) |
| `14px` | [css/style.css:659](../public/css/style.css) |
| `12px 16px` | [css/style.css:682](../public/css/style.css) |
| `8px` | [css/style.css:1046](../public/css/style.css) |
| `12px` | [css/style.css:1092](../public/css/style.css) |
| `3px` | [css/wb.css:159](../public/css/wb.css) |
| `4px 6px` | [css/wb.css:234](../public/css/wb.css) |
| `10px` | [css/wb.css:265](../public/css/wb.css) |
| `2px 8px` | [css/wb.css:294](../public/css/wb.css) |
| `5px` | [css/wb.css:303](../public/css/wb.css) |
| `1px` | [css/wb.css:359](../public/css/wb.css) |
| `8px 16px` | [css/wb.css:371](../public/css/wb.css) |
| `8px 12px` | [css/wb.css:384](../public/css/wb.css) |
| `4px 12px` | [css/wb.css:515](../public/css/wb.css) |
| `0` | [css/wb.css:572](../public/css/wb.css) |
| `2px 0` | [css/wb.css:583](../public/css/wb.css) |
| `6px 8px` | [css/wb.css:611](../public/css/wb.css) |
| `8px 30px` | [css/wb.css:642](../public/css/wb.css) |
| `14px 22px` | [css/wb.css:648](../public/css/wb.css) |
| `10px 12px` | [css/wb.css:814](../public/css/wb.css) |
| `4px 0` | [css/wb.css:851](../public/css/wb.css) |
| `4px 8px` | [css/wb.css:858](../public/css/wb.css) |
| `2px 6px` | [css/wb.css:881](../public/css/wb.css) |
| `2px 14px` | [css/wb.css:940](../public/css/wb.css) |
| `0 8px` | [css/wb.css:966](../public/css/wb.css) |
| `10px 36px` | [css/wb.css:1004](../public/css/wb.css) |
| `7px` | [css/wb.css:1029](../public/css/wb.css) |
| `16px` | [css/wb.css:1074](../public/css/wb.css) |
| `9px` | [css/wb.css:1147](../public/css/wb.css) |
| `4px 10px` | [css/wb.css:1164](../public/css/wb.css) |
| `22px` | [css/wb.css:1175](../public/css/wb.css) |
| `6px 16px` | [css/wb.css:1265](../public/css/wb.css) |
| `6px 18px` | [css/wb.css:1383](../public/css/wb.css) |
| `2px 7px` | [css/wb.css:1440](../public/css/wb.css) |
| `8px 10px` | [css/wb.css:1518](../public/css/wb.css) |
| `18px` | [css/conversation.css:282](../public/css/conversation.css) |
| `20px` | [css/conversation.css:1284](../public/css/conversation.css) |
| `8px 24px` | [css/conversation.css:1352](../public/css/conversation.css) |

### `grid-column`（11种）

| 实际值 | 首个来源 |
|---|---|
| `1 / -1` | [css/wb.css:249](../public/css/wb.css) |
| `4` | [css/wb.css:406](../public/css/wb.css) |
| `3` | [css/wb.css:408](../public/css/wb.css) |
| `1` | [css/wb.css:599](../public/css/wb.css) |
| `2` | [css/wb.css:600](../public/css/wb.css) |
| `2 / -1` | [css/wb.css:611](../public/css/wb.css) |
| `1 / 5` | [css/wb.css:707](../public/css/wb.css) |
| `1 / 4` | [css/wb.css:806](../public/css/wb.css) |
| `auto` | [css/wb.css:969](../public/css/wb.css) |
| `2 / 3` | [css/wb.css:1459](../public/css/wb.css) |
| `1/-1` | [css/conversation.css:970](../public/css/conversation.css) |

### `grid-row`（5种）

| 实际值 | 首个来源 |
|---|---|
| `1` | [css/wb.css:406](../public/css/wb.css) |
| `2` | [css/wb.css:409](../public/css/wb.css) |
| `1 / span 2` | [css/conversation.css:1247](../public/css/conversation.css) |
| `1/span 2` | [css/conversation.css:1560](../public/css/conversation.css) |
| `3` | [css/conversation.css:1689](../public/css/conversation.css) |

### `height`（51种）

| 实际值 | 首个来源 |
|---|---|
| `28px` | [css/style.css:84](../public/css/style.css) |
| `6px` | [css/style.css:99](../public/css/style.css) |
| `36px` | [css/style.css:162](../public/css/style.css) |
| `2px` | [css/style.css:182](../public/css/style.css) |
| `30px` | [css/style.css:233](../public/css/style.css) |
| `15px` | [css/style.css:249](../public/css/style.css) |
| `100dvh` | [css/style.css:542](../public/css/style.css) |
| `100%` | [css/style.css:553](../public/css/style.css) |
| `14px` | [css/style.css:630](../public/css/style.css) |
| `8px` | [css/style.css:673](../public/css/style.css) |
| `32px` | [css/style.css:918](../public/css/style.css) |
| `auto` | [css/style.css:1025](../public/css/style.css) |
| `min(68vh, 720px)` | [css/style.css:1058](../public/css/style.css) |
| `60vh` | [css/style.css:1067](../public/css/style.css) |
| `min(70vh, 850px)` | [css/style.css:1100](../public/css/style.css) |
| `26px` | [css/wb.css:145](../public/css/wb.css) |
| `24px` | [css/wb.css:157](../public/css/wb.css) |
| `12px` | [css/wb.css:163](../public/css/wb.css) |
| `13px` | [css/wb.css:164](../public/css/wb.css) |
| `7px` | [css/wb.css:180](../public/css/wb.css) |
| `48px` | [css/wb.css:183](../public/css/wb.css) |
| `1px` | [css/wb.css:299](../public/css/wb.css) |
| `calc(100% - 7px)` | [css/wb.css:361](../public/css/wb.css) |
| `4px` | [css/wb.css:368](../public/css/wb.css) |
| `16px` | [css/wb.css:373](../public/css/wb.css) |
| `34px` | [css/wb.css:418](../public/css/wb.css) |
| `20px` | [css/wb.css:455](../public/css/wb.css) |
| `11px` | [css/wb.css:456](../public/css/wb.css) |
| `40px` | [css/wb.css:578](../public/css/wb.css) |
| `18px` | [css/wb.css:603](../public/css/wb.css) |
| `var(--wb-h)` | [css/wb.css:634](../public/css/wb.css) |
| `92px` | [css/wb.css:649](../public/css/wb.css) |
| `126px` | [css/wb.css:660](../public/css/wb.css) |
| `9px` | [css/wb.css:671](../public/css/wb.css) |
| `22px` | [css/wb.css:681](../public/css/wb.css) |
| `56px` | [css/wb.css:717](../public/css/wb.css) |
| `10px` | [css/wb.css:1033](../public/css/wb.css) |
| `52px` | [css/wb.css:1541](../public/css/wb.css) |
| `44px` | [css/wb.css:1547](../public/css/wb.css) |
| `var(--conversation-control-height)` | [css/conversation.css:490](../public/css/conversation.css) |
| `25px` | [css/conversation.css:604](../public/css/conversation.css) |
| `var(--c-h)` | [css/conversation.css:1166](../public/css/conversation.css) |
| `calc(var(--c-h) - 8px)` | [css/conversation.css:1327](../public/css/conversation.css) |
| `9px !important` | [css/conversation.css:1345](../public/css/conversation.css) |
| `220px` | [css/conversation.css:1371](../public/css/conversation.css) |
| `var(--chat-plot-h, 196px)` | [css/conversation.css:1372](../public/css/conversation.css) |
| `72px` | [css/conversation.css:1419](../public/css/conversation.css) |
| `184px` | [css/conversation.css:1459](../public/css/conversation.css) |
| `var(--chat-plot-h, 184px)` | [css/conversation.css:1460](../public/css/conversation.css) |
| `calc(100% + 2px)` | [css/conversation.css:1604](../public/css/conversation.css) |
| `calc(100% - 1.5px)` | [css/conversation.css:1605](../public/css/conversation.css) |

### `justify-content`（4种）

| 实际值 | 首个来源 |
|---|---|
| `space-between` | [css/style.css:46](../public/css/style.css) |
| `center` | [css/style.css:618](../public/css/style.css) |
| `flex-end` | [css/style.css:912](../public/css/style.css) |
| `flex-start` | [css/style.css:1121](../public/css/style.css) |

### `justify-items`（1种）

| 实际值 | 首个来源 |
|---|---|
| `center` | [css/wb.css:637](../public/css/wb.css) |

### `left`（12种）

| 实际值 | 首个来源 |
|---|---|
| `var(--space-sm)` | [css/style.css:180](../public/css/style.css) |
| `2px` | [css/wb.css:206](../public/css/wb.css) |
| `12px` | [css/wb.css:209](../public/css/wb.css) |
| `0` | [css/wb.css:314](../public/css/wb.css) |
| `50%` | [css/wb.css:368](../public/css/wb.css) |
| `57px` | [css/wb.css:464](../public/css/wb.css) |
| `18px` | [css/wb.css:1245](../public/css/wb.css) |
| `3px` | [css/wb.css:1586](../public/css/wb.css) |
| `16px` | [css/conversation.css:1265](../public/css/conversation.css) |
| `0!important` | [css/conversation.css:1554](../public/css/conversation.css) |
| `-1px` | [css/conversation.css:1604](../public/css/conversation.css) |
| `-4px` | [css/conversation.css:1694](../public/css/conversation.css) |

### `letter-spacing`（8种）

| 实际值 | 首个来源 |
|---|---|
| `-0.01em` | [css/style.css:39](../public/css/style.css) |
| `0.05em` | [css/style.css:69](../public/css/style.css) |
| `0.02em` | [css/style.css:92](../public/css/style.css) |
| `0` | [css/style.css:479](../public/css/style.css) |
| `-.01em` | [css/wb.css:185](../public/css/wb.css) |
| `.02em` | [css/wb.css:291](../public/css/wb.css) |
| `.04em` | [css/wb.css:426](../public/css/wb.css) |
| `-0.006em` | [css/conversation.css:1116](../public/css/conversation.css) |

### `line-height`（18种）

| 实际值 | 首个来源 |
|---|---|
| `1.5` | [css/style.css:22](../public/css/style.css) |
| `1.6` | [css/style.css:377](../public/css/style.css) |
| `1.65` | [css/style.css:471](../public/css/style.css) |
| `1.2` | [css/style.css:719](../public/css/style.css) |
| `1` | [css/style.css:884](../public/css/style.css) |
| `18px` | [css/wb.css:170](../public/css/wb.css) |
| `1.55` | [css/wb.css:776](../public/css/wb.css) |
| `1.3` | [css/wb.css:968](../public/css/wb.css) |
| `1.8` | [css/wb.css:1192](../public/css/wb.css) |
| `15px` | [css/wb.css:1291](../public/css/wb.css) |
| `16px` | [css/wb.css:1361](../public/css/wb.css) |
| `24px` | [css/wb.css:1544](../public/css/wb.css) |
| `20px` | [css/wb.css:1575](../public/css/wb.css) |
| `1.4` | [css/conversation.css:150](../public/css/conversation.css) |
| `1.35` | [css/conversation.css:198](../public/css/conversation.css) |
| `1.7` | [css/conversation.css:685](../public/css/conversation.css) |
| `22px` | [css/conversation.css:1117](../public/css/conversation.css) |
| `1.45` | [css/conversation.css:1625](../public/css/conversation.css) |

### `margin`（75种）

| 实际值 | 首个来源 |
|---|---|
| `0` | [css/style.css:30](../public/css/style.css) |
| `0 0 2px` | [css/style.css:65](../public/css/style.css) |
| `var(--space-md) var(--space-md) 0` | [css/style.css:349](../public/css/style.css) |
| `0 0 var(--space-sm)` | [css/style.css:381](../public/css/style.css) |
| `0 0 var(--space-md)` | [css/style.css:403](../public/css/style.css) |
| `1.1em 0 0.45em` | [css/style.css:478](../public/css/style.css) |
| `3px 0` | [css/style.css:489](../public/css/style.css) |
| `var(--space-md) 0` | [css/style.css:516](../public/css/style.css) |
| `0 auto var(--space-md)` | [css/style.css:608](../public/css/style.css) |
| `2px 0 0` | [css/style.css:611](../public/css/style.css) |
| `0 auto` | [css/style.css:640](../public/css/style.css) |
| `var(--space-sm) 0` | [css/style.css:932](../public/css/style.css) |
| `0 0 4px` | [css/style.css:1053](../public/css/style.css) |
| `6px 6px 0 0` | [css/style.css:1114](../public/css/style.css) |
| `8px 0 0` | [css/wb.css:136](../public/css/wb.css) |
| `0 -16px` | [css/wb.css:215](../public/css/wb.css) |
| `12px 16px` | [css/wb.css:370](../public/css/wb.css) |
| `0 0 10px` | [css/wb.css:426](../public/css/wb.css) |
| `4px 0 0` | [css/wb.css:437](../public/css/wb.css) |
| `6px 0 0` | [css/wb.css:438](../public/css/wb.css) |
| `4px 0 3px` | [css/wb.css:486](../public/css/wb.css) |
| `6px 0` | [css/wb.css:501](../public/css/wb.css) |
| `12px 0 4px` | [css/wb.css:505](../public/css/wb.css) |
| `8px 18px` | [css/wb.css:506](../public/css/wb.css) |
| `0 0 8px` | [css/wb.css:513](../public/css/wb.css) |
| `0 0 6px` | [css/wb.css:530](../public/css/wb.css) |
| `0 0 16px` | [css/wb.css:546](../public/css/wb.css) |
| `12px 0` | [css/wb.css:550](../public/css/wb.css) |
| `0 -12px` | [css/wb.css:573](../public/css/wb.css) |
| `48px 16px` | [css/wb.css:637](../public/css/wb.css) |
| `10px 16px 0` | [css/wb.css:640](../public/css/wb.css) |
| `-4.5px 0 0 -4.5px` | [css/wb.css:671](../public/css/wb.css) |
| `16px` | [css/wb.css:677](../public/css/wb.css) |
| `0 7px` | [css/wb.css:855](../public/css/wb.css) |
| `7px 0` | [css/wb.css:861](../public/css/wb.css) |
| `10px 0 0` | [css/wb.css:875](../public/css/wb.css) |
| `12px 20px 0` | [css/wb.css:945](../public/css/wb.css) |
| `0 4px` | [css/wb.css:1037](../public/css/wb.css) |
| `4px 0` | [css/wb.css:1084](../public/css/wb.css) |
| `18px 0` | [css/wb.css:1088](../public/css/wb.css) |
| `8px 0 12px` | [css/wb.css:1093](../public/css/wb.css) |
| `4px 0 10px` | [css/wb.css:1102](../public/css/wb.css) |
| `8px 0` | [css/wb.css:1103](../public/css/wb.css) |
| `10px 0` | [css/wb.css:1117](../public/css/wb.css) |
| `8px 8px 4px 0` | [css/wb.css:1122](../public/css/wb.css) |
| `0 0 18px` | [css/wb.css:1161](../public/css/wb.css) |
| `4px 8px 6px` | [css/wb.css:1225](../public/css/wb.css) |
| `18px -28px 0` | [css/wb.css:1259](../public/css/wb.css) |
| `0 0 12px` | [css/wb.css:1265](../public/css/wb.css) |
| `4px 0 14px` | [css/wb.css:1273](../public/css/wb.css) |
| `-4px 0 0` | [css/wb.css:1413](../public/css/wb.css) |
| `0 0 14px` | [css/wb.css:1431](../public/css/wb.css) |
| `18px -12px 0` | [css/wb.css:1450](../public/css/wb.css) |
| `-20px 0 0 -20px` | [css/wb.css:1501](../public/css/wb.css) |
| `-6.5px 0 0 -6.5px` | [css/wb.css:1502](../public/css/wb.css) |
| `4px auto 8px` | [css/wb.css:1574](../public/css/wb.css) |
| `6px 16px` | [css/conversation.css:249](../public/css/conversation.css) |
| `10px auto 0` | [css/conversation.css:420](../public/css/conversation.css) |
| `auto` | [css/conversation.css:697](../public/css/conversation.css) |
| `2px 0 0 13px` | [css/conversation.css:960](../public/css/conversation.css) |
| `16px 0 0` | [css/conversation.css:1131](../public/css/conversation.css) |
| `0 1px` | [css/conversation.css:1149](../public/css/conversation.css) |
| `20px 0 0` | [css/conversation.css:1166](../public/css/conversation.css) |
| `20px 0 0 auto` | [css/conversation.css:1197](../public/css/conversation.css) |
| `12px 0 0` | [css/conversation.css:1377](../public/css/conversation.css) |
| `0 10px` | [css/conversation.css:1404](../public/css/conversation.css) |
| `0 2px` | [css/conversation.css:1483](../public/css/conversation.css) |
| `-1px` | [css/conversation.css:1492](../public/css/conversation.css) |
| `12px 0 6px` | [css/conversation.css:1538](../public/css/conversation.css) |
| `1px 0 1px -7px` | [css/conversation.css:1588](../public/css/conversation.css) |
| `0 3px` | [css/conversation.css:1594](../public/css/conversation.css) |
| `10px 18px 2px` | [css/conversation.css:1625](../public/css/conversation.css) |
| `4px 0 16px` | [css/conversation.css:1670](../public/css/conversation.css) |
| `0 -4px` | [css/conversation.css:1687](../public/css/conversation.css) |
| `0 2px 0 4px` | [css/conversation.css:1690](../public/css/conversation.css) |

### `margin-block`（1种）

| 实际值 | 首个来源 |
|---|---|
| `6px` | [css/wb.css:1116](../public/css/wb.css) |

### `margin-bottom`（10种）

| 实际值 | 首个来源 |
|---|---|
| `0` | [css/style.css:39](../public/css/style.css) |
| `var(--space-sm)` | [css/style.css:412](../public/css/style.css) |
| `8px` | [css/style.css:1030](../public/css/style.css) |
| `12px` | [css/style.css:1101](../public/css/style.css) |
| `10px` | [css/style.css:1116](../public/css/style.css) |
| `-1px` | [css/wb.css:418](../public/css/wb.css) |
| `4px` | [css/wb.css:969](../public/css/wb.css) |
| `14px` | [css/wb.css:1082](../public/css/wb.css) |
| `-8px` | [css/conversation.css:975](../public/css/conversation.css) |
| `-12px` | [css/conversation.css:1064](../public/css/conversation.css) |

### `margin-inline-end`（3种）

| 实际值 | 首个来源 |
|---|---|
| `8%` | [css/wb.css:1091](../public/css/wb.css) |
| `3%` | [css/wb.css:1136](../public/css/wb.css) |
| `-8px` | [css/conversation.css:1201](../public/css/conversation.css) |

### `margin-inline-start`（6种）

| 实际值 | 首个来源 |
|---|---|
| `8%` | [css/wb.css:1090](../public/css/wb.css) |
| `3%` | [css/wb.css:1135](../public/css/wb.css) |
| `auto` | [css/wb.css:1139](../public/css/wb.css) |
| `0` | [css/conversation.css:1194](../public/css/conversation.css) |
| `-12px` | [css/conversation.css:1215](../public/css/conversation.css) |
| `4px` | [css/conversation.css:1288](../public/css/conversation.css) |

### `margin-left`（9种）

| 实际值 | 首个来源 |
|---|---|
| `auto` | [css/style.css:152](../public/css/style.css) |
| `var(--space-xs)` | [css/style.css:393](../public/css/style.css) |
| `4px` | [css/style.css:975](../public/css/style.css) |
| `10px` | [css/wb.css:191](../public/css/wb.css) |
| `6px` | [css/wb.css:324](../public/css/wb.css) |
| `-2px` | [css/wb.css:368](../public/css/wb.css) |
| `0` | [css/wb.css:823](../public/css/wb.css) |
| `-10px` | [css/wb.css:1443](../public/css/wb.css) |
| `-6px` | [css/conversation.css:1568](../public/css/conversation.css) |

### `margin-right`（6种）

| 实际值 | 首个来源 |
|---|---|
| `6px` | [css/wb.css:204](../public/css/wb.css) |
| `480px` | [css/wb.css:377](../public/css/wb.css) |
| `4px` | [css/wb.css:403](../public/css/wb.css) |
| `-8px` | [css/wb.css:572](../public/css/wb.css) |
| `7px` | [css/wb.css:852](../public/css/wb.css) |
| `auto` | [css/conversation.css:1567](../public/css/conversation.css) |

### `margin-top`（20种）

| 实际值 | 首个来源 |
|---|---|
| `0` | [css/style.css:38](../public/css/style.css) |
| `var(--space-sm)` | [css/style.css:749](../public/css/style.css) |
| `var(--space-xs)` | [css/style.css:825](../public/css/style.css) |
| `8px` | [css/style.css:1062](../public/css/style.css) |
| `10px` | [css/wb.css:412](../public/css/wb.css) |
| `6px` | [css/wb.css:432](../public/css/wb.css) |
| `2px` | [css/wb.css:487](../public/css/wb.css) |
| `14px` | [css/wb.css:646](../public/css/wb.css) |
| `5px` | [css/wb.css:668](../public/css/wb.css) |
| `4px` | [css/wb.css:759](../public/css/wb.css) |
| `3px` | [css/wb.css:783](../public/css/wb.css) |
| `-6.5px` | [css/wb.css:849](../public/css/wb.css) |
| `12px` | [css/wb.css:1106](../public/css/wb.css) |
| `-6px` | [css/wb.css:1362](../public/css/wb.css) |
| `auto` | [css/wb.css:1387](../public/css/wb.css) |
| `-8px` | [css/conversation.css:975](../public/css/conversation.css) |
| `-12px` | [css/conversation.css:1064](../public/css/conversation.css) |
| `16px` | [css/conversation.css:1274](../public/css/conversation.css) |
| `-20px` | [css/conversation.css:1402](../public/css/conversation.css) |
| `-15px` | [css/conversation.css:1500](../public/css/conversation.css) |

### `mask`（6种）

| 实际值 | 首个来源 |
|---|---|
| `var(--wb-ico) center/contain no-repeat` | [css/wb.css:163](../public/css/wb.css) |
| `linear-gradient(currentColor 70%, transparent)` | [css/wb.css:751](../public/css/wb.css) |
| `var(--c-ico-check) center/contain no-repeat` | [css/conversation.css:1158](../public/css/conversation.css) |
| `var(--c-ico-chev) center/contain no-repeat` | [css/conversation.css:1208](../public/css/conversation.css) |
| `var(--c-ico-check-circle) center/contain no-repeat` | [css/conversation.css:1279](../public/css/conversation.css) |
| `var(--c-ico-alert) center/contain no-repeat` | [css/conversation.css:1365](../public/css/conversation.css) |

### `max-height`（23种）

| 实际值 | 首个来源 |
|---|---|
| `70dvh` | [css/style.css:242](../public/css/style.css) |
| `240px` | [css/style.css:425](../public/css/style.css) |
| `none` | [css/style.css:560](../public/css/style.css) |
| `340px` | [css/style.css:843](../public/css/style.css) |
| `calc(100dvh - 64px)` | [css/style.css:867](../public/css/style.css) |
| `19.2em` | [css/style.css:1113](../public/css/style.css) |
| `220px` | [css/style.css:1116](../public/css/style.css) |
| `260px` | [css/wb.css:537](../public/css/wb.css) |
| `80dvh` | [css/wb.css:548](../public/css/wb.css) |
| `9.6em` | [css/wb.css:751](../public/css/wb.css) |
| `min(80dvh, 720px)` | [css/wb.css:951](../public/css/wb.css) |
| `280px` | [css/wb.css:1134](../public/css/wb.css) |
| `calc(100dvh - var(--wb-header-h))` | [css/wb.css:1146](../public/css/wb.css) |
| `180px` | [css/wb.css:1219](../public/css/wb.css) |
| `calc(100dvh - 24px)` | [css/wb.css:1571](../public/css/wb.css) |
| `188px` | [css/conversation.css:826](../public/css/conversation.css) |
| `360px` | [css/conversation.css:1417](../public/css/conversation.css) |
| `72px` | [css/conversation.css:1444](../public/css/conversation.css) |
| `calc(100vh - 24px)` | [css/conversation.css:1527](../public/css/conversation.css) |
| `132px` | [css/conversation.css:1537](../public/css/conversation.css) |
| `200px` | [css/conversation.css:1540](../public/css/conversation.css) |
| `70vh` | [css/conversation.css:1554](../public/css/conversation.css) |
| `85dvh` | [css/conversation.css:1718](../public/css/conversation.css) |

### `max-width`（20种）

| 实际值 | 首个来源 |
|---|---|
| `880px` | [css/style.css:469](../public/css/style.css) |
| `1400px` | [css/style.css:607](../public/css/style.css) |
| `84px` | [css/style.css:711](../public/css/style.css) |
| `100%` | [css/style.css:748](../public/css/style.css) |
| `calc(100vw - 16px)` | [css/style.css:800](../public/css/style.css) |
| `calc(100vw - 32px)` | [css/style.css:866](../public/css/style.css) |
| `220px` | [css/wb.css:186](../public/css/wb.css) |
| `170px` | [css/wb.css:473](../public/css/wb.css) |
| `1180px` | [css/wb.css:984](../public/css/wb.css) |
| `920px` | [css/wb.css:1156](../public/css/wb.css) |
| `760px` | [css/wb.css:1161](../public/css/wb.css) |
| `280px` | [css/wb.css:1185](../public/css/wb.css) |
| `190px` | [css/wb.css:1287](../public/css/wb.css) |
| `14em` | [css/wb.css:1316](../public/css/wb.css) |
| `none` | [css/wb.css:1341](../public/css/wb.css) |
| `7.5em` | [css/wb.css:1478](../public/css/wb.css) |
| `min(900px,100% - 38px)` | [css/conversation.css:333](../public/css/conversation.css) |
| `calc(100% - 35px)` | [css/conversation.css:600](../public/css/conversation.css) |
| `660px` | [css/conversation.css:696](../public/css/conversation.css) |
| `46vw` | [css/conversation.css:1690](../public/css/conversation.css) |

### `min-height`（33种）

| 实际值 | 首个来源 |
|---|---|
| `100dvh` | [css/style.css:29](../public/css/style.css) |
| `640px` | [css/style.css:206](../public/css/style.css) |
| `0` | [css/style.css:361](../public/css/style.css) |
| `520px` | [css/style.css:368](../public/css/style.css) |
| `360px` | [css/style.css:1058](../public/css/style.css) |
| `300px` | [css/style.css:1067](../public/css/style.css) |
| `36px` | [css/style.css:1098](../public/css/style.css) |
| `260px` | [css/style.css:1100](../public/css/style.css) |
| `24px` | [css/wb.css:179](../public/css/wb.css) |
| `48px` | [css/wb.css:213](../public/css/wb.css) |
| `58px` | [css/wb.css:310](../public/css/wb.css) |
| `250px` | [css/wb.css:550](../public/css/wb.css) |
| `3px` | [css/wb.css:663](../public/css/wb.css) |
| `120px` | [css/wb.css:776](../public/css/wb.css) |
| `32px` | [css/wb.css:878](../public/css/wb.css) |
| `40px` | [css/wb.css:966](../public/css/wb.css) |
| `92px` | [css/wb.css:1097](../public/css/wb.css) |
| `64px` | [css/wb.css:1128](../public/css/wb.css) |
| `calc(100dvh - var(--wb-header-h))` | [css/wb.css:1145](../public/css/wb.css) |
| `var(--wb-h)` | [css/wb.css:1203](../public/css/wb.css) |
| `44px` | [css/wb.css:1428](../public/css/wb.css) |
| `52px` | [css/wb.css:1577](../public/css/wb.css) |
| `66px` | [css/conversation.css:172](../public/css/conversation.css) |
| `16px` | [css/conversation.css:341](../public/css/conversation.css) |
| `var(--conversation-control-height)` | [css/conversation.css:489](../public/css/conversation.css) |
| `30px` | [css/conversation.css:640](../public/css/conversation.css) |
| `220px` | [css/conversation.css:688](../public/css/conversation.css) |
| `88px` | [css/conversation.css:1297](../public/css/conversation.css) |
| `76px` | [css/conversation.css:1540](../public/css/conversation.css) |
| `22px` | [css/conversation.css:1588](../public/css/conversation.css) |
| `72px` | [css/conversation.css:1655](../public/css/conversation.css) |
| `34px` | [css/conversation.css:1689](../public/css/conversation.css) |
| `56px` | [css/conversation.css:1715](../public/css/conversation.css) |

### `min-width`（19种）

| 实际值 | 首个来源 |
|---|---|
| `320px` | [css/style.css:28](../public/css/style.css) |
| `44px` | [css/style.css:163](../public/css/style.css) |
| `0` | [css/style.css:211](../public/css/style.css) |
| `36px` | [css/style.css:620](../public/css/style.css) |
| `480px` | [css/style.css:1031](../public/css/style.css) |
| `100px` | [css/style.css:1041](../public/css/style.css) |
| `32px` | [css/wb.css:200](../public/css/wb.css) |
| `1px` | [css/wb.css:360](../public/css/wb.css) |
| `3px` | [css/wb.css:718](../public/css/wb.css) |
| `40px` | [css/wb.css:1187](../public/css/wb.css) |
| `640px` | [css/wb.css:1278](../public/css/wb.css) |
| `560px` | [css/wb.css:1306](../public/css/wb.css) |
| `260px` | [css/conversation.css:24](../public/css/conversation.css) |
| `240px` | [css/conversation.css:537](../public/css/conversation.css) |
| `52px` | [css/conversation.css:764](../public/css/conversation.css) |
| `var(--conversation-control-height)` | [css/conversation.css:838](../public/css/conversation.css) |
| `88px` | [css/conversation.css:1327](../public/css/conversation.css) |
| `18px` | [css/conversation.css:1553](../public/css/conversation.css) |
| `max-content` | [css/conversation.css:1745](../public/css/conversation.css) |

### `opacity`（25种）

| 实际值 | 首个来源 |
|---|---|
| `1` | [css/style.css:136](../public/css/style.css) |
| `0.3` | [css/style.css:137](../public/css/style.css) |
| `0.6` | [css/style.css:139](../public/css/style.css) |
| `0.5` | [css/style.css:194](../public/css/style.css) |
| `0.45` | [css/style.css:250](../public/css/style.css) |
| `0.55` | [css/style.css:345](../public/css/style.css) |
| `0` | [css/style.css:588](../public/css/style.css) |
| `0.4` | [css/style.css:679](../public/css/style.css) |
| `0.48` | [css/style.css:788](../public/css/style.css) |
| `0.62` | [css/style.css:907](../public/css/style.css) |
| `.5` | [css/wb.css:143](../public/css/wb.css) |
| `.38` | [css/wb.css:156](../public/css/wb.css) |
| `.35` | [css/wb.css:341](../public/css/wb.css) |
| `.55` | [css/wb.css:673](../public/css/wb.css) |
| `.4` | [css/wb.css:1551](../public/css/wb.css) |
| `.65` | [css/conversation.css:681](../public/css/conversation.css) |
| `.9` | [css/conversation.css:984](../public/css/conversation.css) |
| `.45` | [css/conversation.css:1176](../public/css/conversation.css) |
| `var(--conversation-swipe,0)` | [css/conversation.css:1500](../public/css/conversation.css) |
| `.2` | [css/conversation.css:1606](../public/css/conversation.css) |
| `.32` | [css/conversation.css:1607](../public/css/conversation.css) |
| `.46` | [css/conversation.css:1608](../public/css/conversation.css) |
| `.62` | [css/conversation.css:1609](../public/css/conversation.css) |
| `.78` | [css/conversation.css:1610](../public/css/conversation.css) |
| `.92` | [css/conversation.css:1611](../public/css/conversation.css) |

### `outline`（6种）

| 实际值 | 首个来源 |
|---|---|
| `2px solid var(--border-focus)` | [css/style.css:190](../public/css/style.css) |
| `none` | [css/style.css:1037](../public/css/style.css) |
| `2px solid var(--wb-accent-line)` | [css/wb.css:166](../public/css/wb.css) |
| `0` | [css/wb.css:305](../public/css/wb.css) |
| `2px solid var(--accent)` | [css/wb.css:676](../public/css/wb.css) |
| `1px solid var(--c-danger-ink)` | [css/conversation.css:1440](../public/css/conversation.css) |

### `outline-offset`（5种）

| 实际值 | 首个来源 |
|---|---|
| `2px` | [css/style.css:190](../public/css/style.css) |
| `-2px` | [css/wb.css:312](../public/css/wb.css) |
| `-3px` | [css/wb.css:1589](../public/css/wb.css) |
| `1px` | [css/conversation.css:957](../public/css/conversation.css) |
| `-1px` | [css/conversation.css:1440](../public/css/conversation.css) |

### `overflow-wrap`（1种）

| 实际值 | 首个来源 |
|---|---|
| `anywhere` | [css/style.css:1101](../public/css/style.css) |

### `padding`（161种）

| 实际值 | 首个来源 |
|---|---|
| `var(--space-md) var(--space-lg)` | [css/style.css:48](../public/css/style.css) |
| `0 10px` | [css/style.css:85](../public/css/style.css) |
| `var(--space-sm) var(--space-lg) 0` | [css/style.css:146](../public/css/style.css) |
| `0 var(--space-md)` | [css/style.css:164](../public/css/style.css) |
| `var(--space-md) var(--space-lg) var(--space-xl)` | [css/style.css:198](../public/css/style.css) |
| `var(--space-md)` | [css/style.css:227](../public/css/style.css) |
| `var(--space-sm)` | [css/style.css:244](../public/css/style.css) |
| `7px 8px 7px` | [css/style.css:257](../public/css/style.css) |
| `3px` | [css/style.css:303](../public/css/style.css) |
| `10px 12px` | [css/style.css:350](../public/css/style.css) |
| `9px 11px` | [css/style.css:382](../public/css/style.css) |
| `2px 8px` | [css/style.css:444](../public/css/style.css) |
| `6px 8px` | [css/style.css:451](../public/css/style.css) |
| `1px 5px` | [css/style.css:498](../public/css/style.css) |
| `0` | [css/style.css:505](../public/css/style.css) |
| `2px var(--space-md)` | [css/style.css:511](../public/css/style.css) |
| `4px 10px` | [css/style.css:527](../public/css/style.css) |
| `0 var(--space-md) var(--space-sm)` | [css/style.css:653](../public/css/style.css) |
| `2px 7px` | [css/style.css:712](../public/css/style.css) |
| `1px 6px` | [css/style.css:735](../public/css/style.css) |
| `var(--space-lg)` | [css/style.css:775](../public/css/style.css) |
| `var(--space-sm) var(--space-md)` | [css/style.css:801](../public/css/style.css) |
| `6px 10px` | [css/style.css:826](../public/css/style.css) |
| `var(--space-lg) 0` | [css/style.css:861](../public/css/style.css) |
| `var(--space-md) var(--space-lg) var(--space-lg)` | [css/style.css:892](../public/css/style.css) |
| `var(--space-sm) var(--space-lg)` | [css/style.css:1001](../public/css/style.css) |
| `var(--space-sm) var(--space-md) var(--space-lg)` | [css/style.css:1022](../public/css/style.css) |
| `8px var(--space-sm)` | [css/style.css:1025](../public/css/style.css) |
| `4px 6px` | [css/style.css:1032](../public/css/style.css) |
| `3px 4px` | [css/style.css:1033](../public/css/style.css) |
| `2px 6px` | [css/style.css:1043](../public/css/style.css) |
| `8px 10px` | [css/style.css:1055](../public/css/style.css) |
| `9px 10px` | [css/style.css:1060](../public/css/style.css) |
| `0 6px` | [css/style.css:1084](../public/css/style.css) |
| `12px 0` | [css/style.css:1092](../public/css/style.css) |
| `0 8px` | [css/style.css:1097](../public/css/style.css) |
| `12px` | [css/style.css:1100](../public/css/style.css) |
| `10px` | [css/style.css:1117](../public/css/style.css) |
| `6px` | [css/style.css:1124](../public/css/style.css) |
| `8px` | [css/style.css:1125](../public/css/style.css) |
| `0 11px` | [css/wb.css:141](../public/css/wb.css) |
| `0 9px` | [css/wb.css:145](../public/css/wb.css) |
| `0 16px` | [css/wb.css:183](../public/css/wb.css) |
| `0 12px 6px` | [css/wb.css:215](../public/css/wb.css) |
| `0 0 var(--space-xl)` | [css/wb.css:230](../public/css/wb.css) |
| `8px 16px` | [css/wb.css:234](../public/css/wb.css) |
| `3px 9px` | [css/wb.css:235](../public/css/wb.css) |
| `1px 7px` | [css/wb.css:239](../public/css/wb.css) |
| `3px 8px` | [css/wb.css:257](../public/css/wb.css) |
| `7px 10px` | [css/wb.css:265](../public/css/wb.css) |
| `10px 16px` | [css/wb.css:310](../public/css/wb.css) |
| `2px 9px 2px 8px` | [css/wb.css:327](../public/css/wb.css) |
| `48px 16px` | [css/wb.css:369](../public/css/wb.css) |
| `12px 16px` | [css/wb.css:371](../public/css/wb.css) |
| `14px 18px 0` | [css/wb.css:395](../public/css/wb.css) |
| `0 0 10px` | [css/wb.css:421](../public/css/wb.css) |
| `12px 18px` | [css/wb.css:425](../public/css/wb.css) |
| `12px 14px` | [css/wb.css:427](../public/css/wb.css) |
| `5px 0` | [css/wb.css:447](../public/css/wb.css) |
| `8px 12px` | [css/wb.css:481](../public/css/wb.css) |
| `10px 18px 8px` | [css/wb.css:490](../public/css/wb.css) |
| `6px 18px` | [css/wb.css:495](../public/css/wb.css) |
| `6px 0` | [css/wb.css:496](../public/css/wb.css) |
| `0 18px` | [css/wb.css:504](../public/css/wb.css) |
| `0 12px` | [css/wb.css:507](../public/css/wb.css) |
| `12px 14px 18px` | [css/wb.css:511](../public/css/wb.css) |
| `16px` | [css/wb.css:543](../public/css/wb.css) |
| `18px` | [css/wb.css:544](../public/css/wb.css) |
| `2px 12px 0` | [css/wb.css:568](../public/css/wb.css) |
| `0 2px` | [css/wb.css:573](../public/css/wb.css) |
| `6px 12px` | [css/wb.css:583](../public/css/wb.css) |
| `3px 10px 3px 0` | [css/wb.css:584](../public/css/wb.css) |
| `32px` | [css/wb.css:637](../public/css/wb.css) |
| `14px 16px 4px` | [css/wb.css:641](../public/css/wb.css) |
| `0 19%` | [css/wb.css:662](../public/css/wb.css) |
| `9px 16px` | [css/wb.css:700](../public/css/wb.css) |
| `14px 16px 8px` | [css/wb.css:701](../public/css/wb.css) |
| `10px 0 10px 16px` | [css/wb.css:707](../public/css/wb.css) |
| `10px 0` | [css/wb.css:726](../public/css/wb.css) |
| `28px 16px` | [css/wb.css:735](../public/css/wb.css) |
| `4px 0` | [css/wb.css:753](../public/css/wb.css) |
| `1px 8px` | [css/wb.css:756](../public/css/wb.css) |
| `7px 0` | [css/wb.css:761](../public/css/wb.css) |
| `16px 18px 24px` | [css/wb.css:771](../public/css/wb.css) |
| `12px 12px 4px` | [css/wb.css:812](../public/css/wb.css) |
| `0 0 12px 12px` | [css/wb.css:830](../public/css/wb.css) |
| `0 12px 12px 0` | [css/wb.css:831](../public/css/wb.css) |
| `12px 12px 6px` | [css/wb.css:832](../public/css/wb.css) |
| `4px 0 18px` | [css/wb.css:911](../public/css/wb.css) |
| `10px 14px 5px` | [css/wb.css:912](../public/css/wb.css) |
| `5px 14px` | [css/wb.css:916](../public/css/wb.css) |
| `7px 14px` | [css/wb.css:926](../public/css/wb.css) |
| `12px 20px` | [css/wb.css:934](../public/css/wb.css) |
| `16px 20px 24px` | [css/wb.css:946](../public/css/wb.css) |
| `4px 0 24px` | [css/wb.css:984](../public/css/wb.css) |
| `12px 16px 10px` | [css/wb.css:1010](../public/css/wb.css) |
| `4px 8px` | [css/wb.css:1026](../public/css/wb.css) |
| `4px 0 2px` | [css/wb.css:1029](../public/css/wb.css) |
| `0 4px` | [css/wb.css:1045](../public/css/wb.css) |
| `14px 16px` | [css/wb.css:1089](../public/css/wb.css) |
| `6px 4px` | [css/wb.css:1109](../public/css/wb.css) |
| `14px 9px 14px 8px` | [css/wb.css:1146](../public/css/wb.css) |
| `22px 28px 40px` | [css/wb.css:1155](../public/css/wb.css) |
| `7px 16px` | [css/wb.css:1203](../public/css/wb.css) |
| `5px 8px` | [css/wb.css:1221](../public/css/wb.css) |
| `12px 28px` | [css/wb.css:1259](../public/css/wb.css) |
| `10px 14px` | [css/wb.css:1268](../public/css/wb.css) |
| `9px 14px` | [css/wb.css:1274](../public/css/wb.css) |
| `3px 6px` | [css/wb.css:1280](../public/css/wb.css) |
| `9px 8px` | [css/wb.css:1308](../public/css/wb.css) |
| `16px 16px 40px` | [css/wb.css:1340](../public/css/wb.css) |
| `0 5px` | [css/wb.css:1361](../public/css/wb.css) |
| `40px 20px` | [css/wb.css:1415](../public/css/wb.css) |
| `8px 10px 16px` | [css/wb.css:1425](../public/css/wb.css) |
| `2px 2px 8px 8px` | [css/wb.css:1427](../public/css/wb.css) |
| `12px 12px 32px` | [css/wb.css:1438](../public/css/wb.css) |
| `8px 6px` | [css/wb.css:1440](../public/css/wb.css) |
| `12px 12px 24px` | [css/wb.css:1516](../public/css/wb.css) |
| `8px 12px 10px` | [css/wb.css:1518](../public/css/wb.css) |
| `0 6px 0 16px` | [css/wb.css:1541](../public/css/wb.css) |
| `6px 0 calc(12px + env(safe-area-inset-bottom))` | [css/wb.css:1571](../public/css/wb.css) |
| `4px 20px 8px` | [css/wb.css:1575](../public/css/wb.css) |
| `0 20px` | [css/wb.css:1577](../public/css/wb.css) |
| `2px` | [css/wb.css:1601](../public/css/wb.css) |
| `12px 8px` | [css/conversation.css:31](../public/css/conversation.css) |
| `0 7px` | [css/conversation.css:51](../public/css/conversation.css) |
| `10px 9px` | [css/conversation.css:80](../public/css/conversation.css) |
| `0 16px 16px` | [css/conversation.css:276](../public/css/conversation.css) |
| `9px` | [css/conversation.css:382](../public/css/conversation.css) |
| `30px 12px` | [css/conversation.css:445](../public/css/conversation.css) |
| `10px 16px 12px` | [css/conversation.css:463](../public/css/conversation.css) |
| `calc((var(--conversation-control-height) - 1lh)/2) 4px` | [css/conversation.css:492](../public/css/conversation.css) |
| `7px 9px` | [css/conversation.css:524](../public/css/conversation.css) |
| `10px 8px` | [css/conversation.css:560](../public/css/conversation.css) |
| `0 3px` | [css/conversation.css:627](../public/css/conversation.css) |
| `max(8px, env(safe-area-inset-top)) 12px 0` | [css/conversation.css:923](../public/css/conversation.css) |
| `2px 8px 2px 6px` | [css/conversation.css:951](../public/css/conversation.css) |
| `3px 0 4px` | [css/conversation.css:970](../public/css/conversation.css) |
| `2px 0 4px` | [css/conversation.css:971](../public/css/conversation.css) |
| `0 9px 7px` | [css/conversation.css:996](../public/css/conversation.css) |
| `var(--c-pad)` | [css/conversation.css:1109](../public/css/conversation.css) |
| `0 12px 0 8px` | [css/conversation.css:1144](../public/css/conversation.css) |
| `0 8px 0 12px` | [css/conversation.css:1201](../public/css/conversation.css) |
| `8px 16px 8px 34px` | [css/conversation.css:1263](../public/css/conversation.css) |
| `12px 16px 12px 12px` | [css/conversation.css:1274](../public/css/conversation.css) |
| `4px` | [css/conversation.css:1323](../public/css/conversation.css) |
| `12px 16px 12px 40px` | [css/conversation.css:1360](../public/css/conversation.css) |
| `8px 4px` | [css/conversation.css:1386](../public/css/conversation.css) |
| `6px 6px 6px 12px` | [css/conversation.css:1502](../public/css/conversation.css) |
| `2px 0` | [css/conversation.css:1506](../public/css/conversation.css) |
| `10px 10px 8px 14px` | [css/conversation.css:1529](../public/css/conversation.css) |
| `0 8px 0 6px` | [css/conversation.css:1588](../public/css/conversation.css) |
| `12px 8px 0` | [css/conversation.css:1647](../public/css/conversation.css) |
| `0 8px 4px` | [css/conversation.css:1648](../public/css/conversation.css) |
| `0 0 8px` | [css/conversation.css:1654](../public/css/conversation.css) |
| `6px 16px` | [css/conversation.css:1687](../public/css/conversation.css) |
| `0 6px 0 9px` | [css/conversation.css:1690](../public/css/conversation.css) |
| `8px 8px 8px 12px` | [css/conversation.css:1699](../public/css/conversation.css) |
| `8px 8px calc(8px + env(safe-area-inset-bottom))` | [css/conversation.css:1703](../public/css/conversation.css) |
| `12px 16px calc(12px + env(safe-area-inset-bottom))` | [css/conversation.css:1715](../public/css/conversation.css) |
| `10px 20px` | [css/conversation.css:1720](../public/css/conversation.css) |

### `padding-bottom`（10种）

| 实际值 | 首个来源 |
|---|---|
| `env(safe-area-inset-bottom)` | [css/wb.css:559](../public/css/wb.css) |
| `1px` | [css/wb.css:717](../public/css/wb.css) |
| `12px` | [css/wb.css:743](../public/css/wb.css) |
| `4px` | [css/wb.css:878](../public/css/wb.css) |
| `0` | [css/wb.css:966](../public/css/wb.css) |
| `16px` | [css/wb.css:1076](../public/css/wb.css) |
| `14px` | [css/wb.css:1082](../public/css/wb.css) |
| `calc(56px + env(safe-area-inset-bottom))` | [css/wb.css:1537](../public/css/wb.css) |
| `10px` | [css/conversation.css:975](../public/css/conversation.css) |
| `calc(10px + env(safe-area-inset-bottom))` | [css/conversation.css:1555](../public/css/conversation.css) |

### `padding-inline-start`（2种）

| 实际值 | 首个来源 |
|---|---|
| `20px` | [css/wb.css:1115](../public/css/wb.css) |
| `26px` | [css/conversation.css:1320](../public/css/conversation.css) |

### `padding-left`（9种）

| 实际值 | 首个来源 |
|---|---|
| `var(--space-md)` | [css/style.css:766](../public/css/style.css) |
| `16px` | [css/wb.css:523](../public/css/wb.css) |
| `36px` | [css/wb.css:925](../public/css/wb.css) |
| `20px` | [css/wb.css:978](../public/css/wb.css) |
| `12px` | [css/wb.css:1041](../public/css/wb.css) |
| `5px` | [css/wb.css:1477](../public/css/wb.css) |
| `12px!important` | [css/conversation.css:592](../public/css/conversation.css) |
| `10px` | [css/conversation.css:1615](../public/css/conversation.css) |
| `6px` | [css/conversation.css:1754](../public/css/conversation.css) |

### `padding-right`（9种）

| 实际值 | 首个来源 |
|---|---|
| `2px` | [css/style.css:154](../public/css/style.css) |
| `var(--space-md)` | [css/style.css:767](../public/css/style.css) |
| `4px` | [css/style.css:847](../public/css/style.css) |
| `16px` | [css/wb.css:734](../public/css/wb.css) |
| `26px` | [css/wb.css:848](../public/css/wb.css) |
| `12px` | [css/wb.css:1041](../public/css/wb.css) |
| `5px` | [css/wb.css:1477](../public/css/wb.css) |
| `12px!important` | [css/conversation.css:593](../public/css/conversation.css) |
| `44px !important` | [css/conversation.css:1314](../public/css/conversation.css) |

### `padding-top`（9种）

| 实际值 | 首个来源 |
|---|---|
| `1px` | [css/wb.css:454](../public/css/wb.css) |
| `8px` | [css/wb.css:475](../public/css/wb.css) |
| `max(14px, env(safe-area-inset-top))` | [css/wb.css:558](../public/css/wb.css) |
| `14px` | [css/wb.css:788](../public/css/wb.css) |
| `0` | [css/wb.css:1055](../public/css/wb.css) |
| `16px` | [css/wb.css:1096](../public/css/wb.css) |
| `10px` | [css/wb.css:1120](../public/css/wb.css) |
| `12px` | [css/wb.css:1190](../public/css/wb.css) |
| `18px` | [css/conversation.css:283](../public/css/conversation.css) |

### `position`（5种）

| 实际值 | 首个来源 |
|---|---|
| `sticky` | [css/style.css:49](../public/css/style.css) |
| `relative` | [css/style.css:174](../public/css/style.css) |
| `absolute` | [css/style.css:178](../public/css/style.css) |
| `fixed` | [css/style.css:797](../public/css/style.css) |
| `static` | [css/wb.css:592](../public/css/wb.css) |

### `right`（9种）

| 实际值 | 首个来源 |
|---|---|
| `var(--space-sm)` | [css/style.css:181](../public/css/style.css) |
| `6px` | [css/style.css:733](../public/css/style.css) |
| `-6px` | [css/style.css:984](../public/css/style.css) |
| `20px` | [css/style.css:1118](../public/css/style.css) |
| `0` | [css/wb.css:361](../public/css/wb.css) |
| `8px` | [css/wb.css:849](../public/css/wb.css) |
| `12px` | [css/conversation.css:1315](../public/css/conversation.css) |
| `0!important` | [css/conversation.css:1554](../public/css/conversation.css) |
| `-2px` | [css/conversation.css:1694](../public/css/conversation.css) |

### `row-gap`（5种）

| 实际值 | 首个来源 |
|---|---|
| `0` | [css/wb.css:213](../public/css/wb.css) |
| `6px` | [css/wb.css:388](../public/css/wb.css) |
| `8px` | [css/wb.css:598](../public/css/wb.css) |
| `4px` | [css/wb.css:1479](../public/css/wb.css) |
| `1px` | [css/conversation.css:960](../public/css/conversation.css) |

### `text-align`（4种）

| 实际值 | 首个来源 |
|---|---|
| `left` | [css/style.css:262](../public/css/style.css) |
| `center` | [css/style.css:440](../public/css/style.css) |
| `right` | [css/style.css:1040](../public/css/style.css) |
| `inherit` | [css/conversation.css:1057](../public/css/conversation.css) |

### `text-decoration`（3种）

| 实际值 | 首个来源 |
|---|---|
| `underline` | [css/style.css:494](../public/css/style.css) |
| `none` | [css/wb.css:161](../public/css/wb.css) |
| `underline dotted` | [css/wb.css:1299](../public/css/wb.css) |

### `text-underline-offset`（2种）

| 实际值 | 首个来源 |
|---|---|
| `2px` | [css/style.css:495](../public/css/style.css) |
| `3px` | [css/wb.css:1299](../public/css/wb.css) |

### `top`（18种）

| 实际值 | 首个来源 |
|---|---|
| `0` | [css/style.css:50](../public/css/style.css) |
| `-2px` | [css/style.css:983](../public/css/style.css) |
| `2px` | [css/wb.css:206](../public/css/wb.css) |
| `var(--wb-header-h)` | [css/wb.css:291](../public/css/wb.css) |
| `-10px` | [css/wb.css:464](../public/css/wb.css) |
| `12%` | [css/wb.css:548](../public/css/wb.css) |
| `17px` | [css/wb.css:673](../public/css/wb.css) |
| `5px` | [css/wb.css:682](../public/css/wb.css) |
| `50%` | [css/wb.css:849](../public/css/wb.css) |
| `-4px` | [css/wb.css:871](../public/css/wb.css) |
| `22px` | [css/wb.css:1300](../public/css/wb.css) |
| `3px` | [css/wb.css:1586](../public/css/wb.css) |
| `15px` | [css/conversation.css:1265](../public/css/conversation.css) |
| `16px` | [css/conversation.css:1364](../public/css/conversation.css) |
| `-6px` | [css/conversation.css:1553](../public/css/conversation.css) |
| `auto!important` | [css/conversation.css:1554](../public/css/conversation.css) |
| `-1px` | [css/conversation.css:1604](../public/css/conversation.css) |
| `-11px` | [css/conversation.css:1694](../public/css/conversation.css) |

### `transform`（24种）

| 实际值 | 首个来源 |
|---|---|
| `none` | [css/style.css:577](../public/css/style.css) |
| `scale(0.985)` | [css/style.css:588](../public/css/style.css) |
| `scale(0.965)` | [css/style.css:592](../public/css/style.css) |
| `scale(1.025)` | [css/style.css:593](../public/css/style.css) |
| `scale(1)` | [css/style.css:814](../public/css/style.css) |
| `scale(0.85)` | [css/style.css:815](../public/css/style.css) |
| `translateY(6px)` | [css/style.css:819](../public/css/style.css) |
| `translateY(0)` | [css/style.css:820](../public/css/style.css) |
| `scale(0.98)` | [css/style.css:970](../public/css/style.css) |
| `rotate(90deg)` | [css/wb.css:445](../public/css/wb.css) |
| `translateX(-50%)` | [css/wb.css:548](../public/css/wb.css) |
| `scale(1.25)` | [css/wb.css:678](../public/css/wb.css) |
| `translateX(-100%)` | [css/wb.css:685](../public/css/wb.css) |
| `translateX(-104%)` | [css/wb.css:1425](../public/css/wb.css) |
| `translateX(16px)` | [css/wb.css:1588](../public/css/wb.css) |
| `rotate(360deg)` | [css/conversation.css:983](../public/css/conversation.css) |
| `translateY(-3px)` | [css/conversation.css:984](../public/css/conversation.css) |
| `translateX(var(--conversation-swipe-offset,0))` | [css/conversation.css:1012](../public/css/conversation.css) |
| `translateX(-88px)` | [css/conversation.css:1013](../public/css/conversation.css) |
| `translateY(1px)` | [css/conversation.css:1174](../public/css/conversation.css) |
| `scale(0)` | [css/conversation.css:1231](../public/css/conversation.css) |
| `scale(calc(.6 + .4 * var(--conversation-swipe,0)))` | [css/conversation.css:1500](../public/css/conversation.css) |
| `scale(1.08)` | [css/conversation.css:1519](../public/css/conversation.css) |
| `scale(1.5)` | [css/conversation.css:1620](../public/css/conversation.css) |

### `white-space`（4种）

| 实际值 | 首个来源 |
|---|---|
| `nowrap` | [css/style.css:158](../public/css/style.css) |
| `pre-wrap` | [css/style.css:445](../public/css/style.css) |
| `normal` | [css/style.css:1025](../public/css/style.css) |
| `pre-line` | [css/wb.css:167](../public/css/wb.css) |

### `width`（70种）

| 实际值 | 首个来源 |
|---|---|
| `6px` | [css/style.css:98](../public/css/style.css) |
| `30px` | [css/style.css:232](../public/css/style.css) |
| `15px` | [css/style.css:249](../public/css/style.css) |
| `100%` | [css/style.css:254](../public/css/style.css) |
| `14px` | [css/style.css:630](../public/css/style.css) |
| `8px` | [css/style.css:672](../public/css/style.css) |
| `fit-content` | [css/style.css:747](../public/css/style.css) |
| `280px` | [css/style.css:799](../public/css/style.css) |
| `400px` | [css/style.css:865](../public/css/style.css) |
| `28px` | [css/style.css:876](../public/css/style.css) |
| `32px` | [css/style.css:917](../public/css/style.css) |
| `auto` | [css/style.css:1023](../public/css/style.css) |
| `70px` | [css/style.css:1040](../public/css/style.css) |
| `68px` | [css/style.css:1084](../public/css/style.css) |
| `0` | [css/style.css:1095](../public/css/style.css) |
| `24px` | [css/wb.css:157](../public/css/wb.css) |
| `12px` | [css/wb.css:163](../public/css/wb.css) |
| `13px` | [css/wb.css:164](../public/css/wb.css) |
| `7px` | [css/wb.css:180](../public/css/wb.css) |
| `22px` | [css/wb.css:205](../public/css/wb.css) |
| `52px` | [css/wb.css:244](../public/css/wb.css) |
| `4px` | [css/wb.css:254](../public/css/wb.css) |
| `1px` | [css/wb.css:299](../public/css/wb.css) |
| `130px` | [css/wb.css:305](../public/css/wb.css) |
| `3px` | [css/wb.css:314](../public/css/wb.css) |
| `10px` | [css/wb.css:373](../public/css/wb.css) |
| `480px` | [css/wb.css:393](../public/css/wb.css) |
| `38%` | [css/wb.css:448](../public/css/wb.css) |
| `20px` | [css/wb.css:455](../public/css/wb.css) |
| `11px` | [css/wb.css:456](../public/css/wb.css) |
| `110px` | [css/wb.css:472](../public/css/wb.css) |
| `max-content` | [css/wb.css:507](../public/css/wb.css) |
| `16px` | [css/wb.css:532](../public/css/wb.css) |
| `420px` | [css/wb.css:544](../public/css/wb.css) |
| `min(640px, calc(100vw - 32px))` | [css/wb.css:548](../public/css/wb.css) |
| `40px` | [css/wb.css:625](../public/css/wb.css) |
| `92px` | [css/wb.css:649](../public/css/wb.css) |
| `9px` | [css/wb.css:671](../public/css/wb.css) |
| `170px` | [css/wb.css:695](../public/css/wb.css) |
| `200px` | [css/wb.css:696](../public/css/wb.css) |
| `min(880px, 100%)` | [css/wb.css:951](../public/css/wb.css) |
| `196px` | [css/wb.css:986](../public/css/wb.css) |
| `28%` | [css/wb.css:1110](../public/css/wb.css) |
| `42%` | [css/wb.css:1111](../public/css/wb.css) |
| `30%` | [css/wb.css:1114](../public/css/wb.css) |
| `209px` | [css/wb.css:1146](../public/css/wb.css) |
| `84px` | [css/wb.css:1182](../public/css/wb.css) |
| `220px` | [css/wb.css:1183](../public/css/wb.css) |
| `min(100%, 280px)` | [css/wb.css:1185](../public/css/wb.css) |
| `72px` | [css/wb.css:1235](../public/css/wb.css) |
| `36px` | [css/wb.css:1242](../public/css/wb.css) |
| `34px` | [css/wb.css:1296](../public/css/wb.css) |
| `300px` | [css/wb.css:1300](../public/css/wb.css) |
| `64px` | [css/wb.css:1400](../public/css/wb.css) |
| `min(300px, 84vw)` | [css/wb.css:1425](../public/css/wb.css) |
| `44px` | [css/wb.css:1547](../public/css/wb.css) |
| `18px` | [css/wb.css:1586](../public/css/wb.css) |
| `320px` | [css/conversation.css:23](../public/css/conversation.css) |
| `26px` | [css/conversation.css:56](../public/css/conversation.css) |
| `25px` | [css/conversation.css:603](../public/css/conversation.css) |
| `var(--conversation-control-height)` | [css/conversation.css:838](../public/css/conversation.css) |
| `520px` | [css/conversation.css:950](../public/css/conversation.css) |
| `88px` | [css/conversation.css:1015](../public/css/conversation.css) |
| `min(var(--c-max), calc(100% - 38px))` | [css/conversation.css:1101](../public/css/conversation.css) |
| `9px !important` | [css/conversation.css:1345](../public/css/conversation.css) |
| `calc(100% - 35px)` | [css/conversation.css:1450](../public/css/conversation.css) |
| `auto!important` | [css/conversation.css:1554](../public/css/conversation.css) |
| `calc(100% + 2px)` | [css/conversation.css:1604](../public/css/conversation.css) |
| `calc(100% - 1.5px)` | [css/conversation.css:1605](../public/css/conversation.css) |
| `calc(100% + 8px)` | [css/conversation.css:1689](../public/css/conversation.css) |

### `word-break`（3种）

| 实际值 | 首个来源 |
|---|---|
| `break-word` | [css/style.css:834](../public/css/style.css) |
| `keep-all` | [css/wb.css:307](../public/css/wb.css) |
| `break-all` | [css/wb.css:1322](../public/css/wb.css) |

</details>

## 附录 C. JavaScript / Canvas 补充

<details>
<summary>展开完整实际值与源码定位</summary>




- `js/wb/usage.js:6` 图表系列颜色 `#0d9488 / #6366f1 / #d97706` 固定，不随主题换色；104–106文字读取text-muted/text、格线border、panel bg-elevated，fallback见下。图表柱radius0/3/4、line border2、maxBarThickness34，frame220px。
- `js/wb/conversation-charts.js:5` 系列色 `#35a998 / #e1a33d / #4f8cf7 / #e06b83 / #aa79e8 / #73859f`；188起default palette并非所有主题的实际颜色，423–427从computed主题读取text-dim/text-muted/text、border、bg-elevated、text/bg以及font-family。饼图label ink在99按相对亮度选 `#0b1220` 或 `#ffffff`。
- 两套chart系列色不同，建议同一语义系列跨页采用一套映射、保持对比度与可识别性，具体颜色「待 Howard 定」，不能把以上固定色遗漏成仅CSS主题。
- `js/wb/instance-strip.js:10–13` quota剩余色调按剩余百分比钳制后 ×1.2，文字HSL饱和75%、亮度var(--wb-quota-lightness)；fill饱和/亮度用wb-quota-fill-*。亮26%/fill85%,45%，暗68%/fill75%,68%。这不是离散warning/success色表。
- `js/wb/plain-text.js:9–12` icon helper产出`i.wb-ico.wb-ico-{name}[.wb-ico-{size}]`且aria-hidden=true，证实使用现有mask集合，无需新图标包。

下列为非vendor JS中与实际视觉取值有关的声明行（保留完整值/位置，含Canvas）：

### js/agent-fleet.js

```text
83:   return agent?.color || '#64748b';
```

### js/wb/conversation-charts.js

```text
5: const colors = ['#35a998', '#e1a33d', '#4f8cf7', '#e06b83', '#aa79e8', '#73859f'];
98:   const darkLuminance = 0.00546; // #0b1220, compared with white by relative luminance.
99:   return (luminance + 0.05) / (darkLuminance + 0.05) >= 1.05 / (luminance + 0.05) ? '#0b1220' : '#ffffff';
120:     ctx.font = `600 12px ${font}`;
148:       ctx.font = `600 12px ${font}`; ctx.textAlign = 'left'; ctx.fillStyle = strong;
156:       ctx.font = `500 12px ${font}`; ctx.fillStyle = text;
166:         ctx.font = `500 11.5px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
173:       ctx.font = `600 12px ${font}`; ctx.textAlign = 'center';
188: export function conversationChartConfig(block, { text = '#526170', muted = '#7a8794', strong = '#101827', grid = '#7a879424',
189:   surface = '#ffffff', tooltipBg = '#101827', tooltipText = '#f7faf9', font = 'Inter, system-ui, sans-serif',
198:     ? { suggestedMax: data.format?.style === 'percent' ? 1 : 100 } : {}), title: { display: !!title, text: title, color: text, font: tickFont },
199:     ticks: { color: text, font: tickFont, padding: 8, maxTicksLimit: 6, callback: tick(unit), ...(data.format?.style === 'percent' || unit === '%'
210:     const xTicks = { color: text, font: tickFont, padding: 8, maxRotation: 0, autoSkipPadding: 16 };
212:       title: { display: !!data.xLabel, text: data.xLabel, color: text, font: tickFont }, ticks: xTicks,
257:       datasets.push({ label: series.label, data: rows, borderColor: color, borderWidth: category ? 0 : 2,
266:         borderRadius: category ? 4 : 0, maxBarThickness: 28, cubicInterpolationMode: 'monotone', spanGaps: false,
267:         pointRadius: category ? 0 : context => present(context.dataIndex) && (context.dataIndex === last ||
277:       title: { display: !!data.yLabel, text: data.yLabel, color: text, font: { ...tickFont, lineHeight: '16px' }, padding: 8 },
280:       ticks: { color: text, font: { family: font, size: 12 }, padding: 12, crossAlign: 'far', autoSkip: false },
287:       borderRadius: 4, borderSkipped: 'start', barThickness: 20, categoryPercentage: 1, unit: data.unit });
290:       borderColor: muted, borderDash: [4, 4], borderWidth: 1.25, pointRadius: 0, pointHoverRadius: 0, unit: data.unit });
300:       borderWidth: { top: 0, bottom: 0, left: 1.5, right: 1.5 }, borderSkipped: false, borderRadius: 6,
309:     font: { family: font }, layout: { autoPadding: block.type === 'time_series',
310:       padding: { top: block.type === 'category_series' ? (data.reference ? 18 : 0) : block.type === 'breakdown' ? 0 : 6, right: 0, bottom: 0, left: 0 } },
314:       labels: { color: text, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8, padding: 16, font: { family: font, size: 12 } } },
315:     tooltip: { backgroundColor: tooltipBg, titleColor: tooltipText, bodyColor: tooltipText, borderWidth: 0, cornerRadius: 8,
316:       padding: { x: 10, y: 8 }, caretPadding: 8, titleMarginBottom: 4, usePointStyle: true,
334:     swatch.style.background = colors[index % colors.length]; swatch.setAttribute('aria-hidden', 'true');
427:           tooltipBg: read('--text'), tooltipText: read('--bg'), font: read('font-family'),
```

### js/wb/host-panel.js

```text
13:   probe.style.color = `color-mix(in srgb, ${color} ${percent}%, transparent)`;
36:     { label: t('wb.host.avg'), data: avg, borderColor: color, backgroundColor: mixColor(document, root, color, 13), fill: 'origin', borderWidth: 1.5, pointRadius: 0, spanGaps: false, tension: 0.25 },
37:     { label: t('wb.host.max'), data: max, borderColor: mixColor(document, root, color, 55), borderDash: [3, 3], borderWidth: 1, pointRadius: 0, spanGaps: false, fill: false },
41:     scales: { x: { display: axis, grid: { display: false }, ticks: { color, maxTicksLimit: 6, maxRotation: 0, autoSkip: true, font: { size: 10 } } },
42:       y: { min: 0, max: 100, ticks: { color, stepSize: 50, font: { size: 10 }, callback: value => value + '%' }, grid: { color: grid }, border: { display: false } } } } };
```

### js/wb/instance-strip.js

```text
12: export const quotaColor = remaining => `hsl(${quotaHue(remaining)} 75% var(--wb-quota-lightness))`;
13: export const quotaFillColor = remaining => `hsl(${quotaHue(remaining)} var(--wb-quota-fill-saturation) var(--wb-quota-fill-lightness))`;
30:   const fill = element(document, 'i'); fill.style.width = pct + '%'; fill.style.backgroundColor = quotaFillColor(pct);
100:       if (pct != null) amount.style.color = quotaColor(pct);
```

### js/wb/usage.js

```text
6: const colors = ['#0d9488', '#6366f1', '#d97706'];
51:       swatch.style.background = item.color;
104:   const textColor = style?.getPropertyValue('--text-muted').trim() || style?.getPropertyValue('--text').trim() || '#101827';
105:   const gridColor = style?.getPropertyValue('--border').trim() || 'rgba(15,118,110,0.16)';
111:     borderWidth: type === 'line' ? 2 : stacked && !mirror && index < top ? { top: 2 } : 0, pointRadius: 0, spanGaps: false,
112:     ...(type === 'bar' ? { borderRadius: mirror ? 3 : stacked && index < top ? 0 : 4, borderSkipped: mirror ? false : 'start',
113:       maxBarThickness: 34, categoryPercentage: 0.62 } : {}),
```

</details>
