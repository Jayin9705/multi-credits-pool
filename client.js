window.__ModuleLoader__.load({
	id: 'multi-credits-pool',
	factory: require => {
		const module = { exports: {} }
		const exports = module.exports
		const react = require('react')

		/**
		 * 浏览器半边：设置卡片、侧边栏入口、中栏看板。
		 *
		 * 三个界面共用同一份数据与同一组动作，都只通过本插件自己的两个 HTTP 路由读写，
		 * 不依赖宿主的配置服务——宿主版本之间那套服务换过名字，插件自己的文件反而稳定。
		 *
		 * 样式走两条通道：颜色一律用宿主的 `--dsw-alias-*` 变量（深浅色主题自动跟随），
		 * 而布局、动效、悬停态这些没法写成内联对象的东西，注入一张自己的样式表。
		 * 内联样式写不出 :hover 与 transition，那是上一版看着「不丝滑」的根因。
		 */
		const name = 'multi-credits-pool-client'
		const inject = ['slots']
		const PACKAGE_NAME = 'multi-credits-pool'
		const PANEL_TITLE = 'multi-credits-pool'
		const WEB_BASE = '/plugins/multi-credits-pool'
		const PLUGIN_SETTINGS_SECTION_ID = 'plugin-settings'
		const PLUGIN_SETTINGS_ITEM_SLOT = 'plugin-settings.item'
		const PANEL_ID = 'multi-credits-pool-panel'
		/** 顶栏那颗星指向的仓库：既是源码入口，也是「点亮」的地方。 */
		const REPO_URL = 'https://github.com/dzdeng7-sudo/multi-credits-pool'
		const SIDEBAR_ID = 'multi-credits-pool-sidebar'
		const CONVERSATION_PANEL_ID = 'conversation'
		/** 对话标题栏右侧的工具位（宿主 client-ui-conversation 声明，session 作用域）。 */
		const CONVERSATION_UTILITIES_SLOT = 'conversation.session.header.utilities'
		const CONVERSATION_PICKER_ID = 'multi-credits-pool-account-picker'
		const MINUTES_PER_DAY = 1440
		const RECENT_LIMIT = 8
		const STATE_POLL_MS = 2000
		/** 后台静默刷新间隔：数字自己变，用户不用点「刷新」。 */
		const AUTO_REFRESH_MS = 30_000
		/** 看板与侧边栏共用一份状态，谁刷新都推给所有订阅者。 */
		const SIDEBAR_REFRESH_MS = AUTO_REFRESH_MS
		/** 提示条停留时长，够读完一行字，又不挡着下一次操作。 */
		const NOTICE_MS = 3600
		const CSS_ID = 'multi-credits-pool/client.css'

		const TABS = [
			{ id: 'pool', label: '账号池' },
			{ id: 'usage', label: '使用看板' },
			{ id: 'feed', label: '签到动态' },
			{ id: 'auto', label: '自动化' },
		]

		/**
		 * 四种账号调用方式。`hint` 写清代价——切换模式会改变上游缓存命中率，
		 * 用户点之前要知道自己在换什么。
		 */
		const STRATEGY_OPTIONS = [
			{
				id: 'sticky',
				label: '对话固定',
				hint: '一段对话始终用同一个账号，新对话才换下一个。上游缓存命中率最高，速度最稳。',
				recommended: true,
			},
			{
				id: 'sequential',
				label: '优先用完一个',
				hint: '先把这个账号的积分用到底，再换下一个。账号之间不来回跳。',
			},
			{
				id: 'expiring',
				label: '优先过期',
				hint: '先用快到期的积分，减少作废。需要先读到每个账号的到期时间。',
			},
			{
				id: 'round-robin',
				label: '轮询',
				hint: '每次请求换下一个账号，消耗摊平。上下文缓存基本吃不到，速度会慢一些。',
			},
		]

		/**
		 * 分段积分的颜色只表示「多久后作废」，不表示身份。
		 *
		 * 用七种彩虹色区分不同积分包看着热闹，但读不出任何结论；而每一段真正要回答的
		 * 问题是「这块还能用几天」。同一套颜色同时出现在额度条和明细行的圆点上，
		 * 条子与列表就共享一个颜色语言：越红越先作废。
		 */
		const EXPIRY_COLORS = {
			soon: '#ef4444',
			near: '#d97706',
			far: '#22a06b',
			unknown: '#7d838c',
		}		/** 头像底色：按账号 id 散列取一个，同一账号每次打开都是同一个色。 */
		const AVATAR_GRADIENTS = [
			'linear-gradient(135deg,#5686fe,#3b62d6)',
			'linear-gradient(135deg,#22a06b,#158055)',
			'linear-gradient(135deg,#a855f7,#7c3aed)',
			'linear-gradient(135deg,#f59e0b,#d97706)',
			'linear-gradient(135deg,#0ea5e9,#0284c7)',
			'linear-gradient(135deg,#f472b6,#db2777)',
		]

		/**
		 * 模型在横条里的颜色：与积分分段的「到期色」不是一套语言，
		 * 这里只用来区分不同模型，不表达好坏。
		 */
		const MODEL_COLORS = ['#5686fe', '#22a06b', '#a855f7', '#f59e0b', '#0ea5e9', '#f472b6', '#8b5cf6', '#14b8a6']

		const h = react.createElement

		const PANEL_CSS = `
.credits-page{--credits-card:var(--dsw-alias-bg-layer-2,#232529);--credits-raise:var(--dsw-alias-bg-layer-3,#2a2c33);--credits-line:var(--dsw-alias-border-l2,#36373b);--credits-fg:var(--dsw-alias-label-primary,#e6e6e6);--credits-fg2:var(--dsw-alias-label-secondary,#c6c9d0);--credits-fg3:var(--dsw-alias-label-tertiary,#9aa0a8);--credits-dim:var(--dsw-alias-label-dimmed,#777);--credits-ok:var(--dsw-alias-state-success-primary,#22a06b);--credits-warn:var(--dsw-alias-state-warning-primary,#d97706);--credits-bad:var(--dsw-alias-state-error-primary,#ef4444);--credits-brand:var(--dsw-alias-brand-primary,#5686fe);--credits-bg:var(--dsw-alias-bg-base,#191a1e);flex:1 1 auto;min-height:0;max-height:100%;width:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:color-mix(in oklab,var(--credits-fg) 20%,transparent) transparent;padding:0 clamp(14px,2.4vw,28px) 28px;color:var(--credits-fg);font-size:13px;line-height:1.55;box-sizing:border-box}
.credits-page *,.credits-page *::before,.credits-page *::after{box-sizing:border-box}
/* 中栏是 overflow:hidden 的列，滚动必须由面板自己承担：内容比窗口高时不再被裁掉。 */
.credits-body{display:flex;flex-direction:column;gap:16px;width:100%;max-width:920px;margin-inline:auto}
.credits-sticky{position:sticky;top:0;z-index:20;display:flex;flex-direction:column;gap:10px;padding:14px 0 10px;background:var(--credits-bg);box-shadow:0 1px 0 color-mix(in oklab,var(--credits-line) 55%,transparent)}
.credits-page[data-variant="settings"]{flex:0 0 auto;min-height:0;overflow:visible;padding:0;gap:10px}
.credits-page[data-variant="settings"] .credits-body{gap:10px;max-width:none}
.credits-page[data-variant="settings"] .credits-sticky{position:static;padding:0;background:none;box-shadow:none}
.credits-page[data-busy="true"]{cursor:progress}

/* ---------- 顶栏 ---------- */
.credits-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.credits-id{display:flex;align-items:center;gap:11px;min-width:0}
.credits-logo{flex:none;width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1;color:#fff;background:linear-gradient(135deg,#5686fe,#8b5cf6 55%,#22a06b);box-shadow:0 6px 18px -8px rgba(86,134,254,.95),inset 0 1px 0 rgba(255,255,255,.38)}
.credits-name{margin:0;display:flex;align-items:center;gap:7px;font-size:15px;font-weight:650;letter-spacing:-.01em;line-height:1.4}
.credits-ver{flex:none;padding:0 6px;border-radius:999px;border:1px solid color-mix(in oklab,var(--credits-fg) 20%,transparent);font-size:10px;font-weight:600;line-height:16px;letter-spacing:.04em;color:var(--credits-fg3)}
.credits-sub{margin:1px 0 0;font-size:11.5px;line-height:1.45;color:var(--credits-fg3);font-variant-numeric:tabular-nums}
.credits-head-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
/* 星标：胶囊形状与按钮尺寸对齐，但用品牌色描边，让它一眼是「去仓库」而不是又一个操作。 */
.credits-star{position:relative;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;overflow:hidden;text-decoration:none;white-space:nowrap;font:inherit;font-size:12.5px;font-weight:600;line-height:18px;border:1px solid color-mix(in oklab,var(--credits-brand) 52%,transparent);background:linear-gradient(140deg,color-mix(in oklab,var(--credits-brand) 16%,transparent),transparent 70%);color:var(--credits-brand);transition:transform .18s ease,box-shadow .22s ease,background .22s ease,border-color .22s ease}
.credits-star:hover{transform:translateY(-1px);border-color:color-mix(in oklab,var(--credits-brand) 72%,transparent);box-shadow:0 0 0 3px color-mix(in oklab,var(--credits-brand) 10%,transparent),0 7px 18px -8px color-mix(in oklab,var(--credits-brand) 70%,transparent)}
.credits-star:active{transform:translateY(0) scale(.975)}
.credits-star:focus-visible{outline:2px solid var(--credits-brand);outline-offset:1px}
.credits-star svg{flex:none;fill:currentColor;transition:transform .5s cubic-bezier(.34,1.56,.64,1)}
.credits-star:hover svg{transform:rotate(72deg) scale(1.12)}
.credits-star:active svg{transform:rotate(72deg) scale(.94)}

/* ---------- 按钮 ---------- */
.credits-btn{appearance:none;font:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 12px;border-radius:9px;font-size:12.5px;font-weight:500;line-height:18px;white-space:nowrap;border:1px solid color-mix(in oklab,var(--credits-line) 85%,transparent);background:var(--credits-raise);color:var(--credits-fg2);transition:background .16s ease,border-color .16s ease,color .16s ease,transform .12s ease,box-shadow .16s ease}
.credits-btn:hover:not(:disabled){color:var(--credits-fg);border-color:color-mix(in oklab,var(--credits-dim) 75%,transparent);background:color-mix(in oklab,var(--credits-raise) 70%,var(--credits-fg) 8%)}
.credits-btn:active:not(:disabled){transform:scale(.975)}
.credits-btn:focus-visible{outline:2px solid var(--credits-brand);outline-offset:1px}
.credits-btn:disabled{opacity:.5;cursor:default}
.credits-btn-primary{border-color:transparent;background:linear-gradient(180deg,#5b8cff,#4a76e8);color:#fff;font-weight:600;box-shadow:0 3px 12px -5px rgba(86,134,254,.9)}
.credits-btn-primary:hover:not(:disabled){background:linear-gradient(180deg,#6b98ff,#5580ec);color:#fff}
.credits-btn-ghost{background:transparent;border-color:transparent;color:var(--credits-fg3)}
.credits-btn-ghost:hover:not(:disabled){background:color-mix(in oklab,var(--credits-fg) 9%,transparent);color:var(--credits-fg);border-color:transparent}
.credits-btn-icon{padding:0;width:28px;height:28px;border-radius:8px;background:transparent;border-color:transparent;color:var(--credits-fg3);font-size:15px;line-height:1}
.credits-btn-danger:hover:not(:disabled){color:var(--credits-bad);border-color:color-mix(in oklab,var(--credits-bad) 45%,transparent);background:color-mix(in oklab,var(--credits-bad) 10%,transparent)}

/* ---------- 标签页 ---------- */
.credits-tabs{display:flex;gap:4px;padding:4px;border-radius:12px;border:1px solid color-mix(in oklab,var(--credits-line) 85%,transparent);background:var(--credits-raise)}
.credits-tab{appearance:none;font:inherit;flex:1;min-width:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 10px;border-radius:8px;border:0;background:transparent;color:var(--credits-fg3);font-size:12.5px;font-weight:500;line-height:18px;transition:color .16s ease,background .16s ease,box-shadow .16s ease}
.credits-tab:hover:not([data-active="true"]){color:var(--credits-fg);background:color-mix(in oklab,var(--credits-fg) 6%,transparent)}
.credits-tab:focus-visible{outline:2px solid var(--credits-brand);outline-offset:1px}
.credits-tab[data-active="true"]{color:var(--credits-fg);background:var(--credits-card);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--credits-line) 90%,transparent)}
.credits-tab-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor;opacity:.85}

/* ---------- 卡片与分节 ---------- */
.credits-card{display:flex;flex-direction:column;gap:12px;padding:15px 17px;border-radius:14px;border:1px solid var(--credits-line);background:var(--credits-card)}
.credits-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.credits-label{margin:0;font-size:10.5px;font-weight:600;line-height:16px;letter-spacing:.06em;text-transform:uppercase;color:var(--credits-fg3)}
.credits-section{margin:0;font-size:13.5px;font-weight:600;line-height:20px;color:var(--credits-fg)}
.credits-aside{font-size:11px;line-height:16px;color:var(--credits-fg3);font-variant-numeric:tabular-nums;white-space:nowrap}
.credits-hint{margin:0;font-size:11.5px;line-height:1.55;color:var(--credits-fg3)}
/* 悬停到未选中项时，说明区换成那一项的内容，并且提亮一档表示「这是预览」。 */
.credits-hint[data-peek="true"]{color:var(--credits-fg2)}
.credits-hint-name{color:var(--credits-fg2);font-weight:600}
.credits-hint-bad{color:var(--credits-bad)}
.credits-hint b{color:var(--credits-fg2);font-weight:600}
.credits-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 18px;border-radius:12px;border:1px dashed color-mix(in oklab,var(--credits-line) 90%,transparent);color:var(--credits-fg3);font-size:12.5px;text-align:center}
.credits-empty-glyph{font-size:20px;line-height:1;opacity:.55}

/* ---------- 指标块 ---------- */
.credits-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:1px;border-radius:12px;overflow:hidden;background:color-mix(in oklab,var(--credits-line) 60%,transparent);border:1px solid color-mix(in oklab,var(--credits-line) 60%,transparent)}
.credits-stat{display:flex;flex-direction:column;gap:1px;padding:10px 12px;background:var(--credits-card);min-width:0}
.credits-stat-k{font-size:10.5px;line-height:15px;color:var(--credits-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.credits-stat-v{font-size:19px;font-weight:650;line-height:1.2;letter-spacing:-.01em;font-variant-numeric:tabular-nums;transition:color .25s ease}
.credits-stat-h{font-size:10.5px;line-height:15px;color:var(--credits-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.credits-tone-ok{color:var(--credits-ok)}
.credits-tone-warn{color:var(--credits-warn)}
.credits-tone-bad{color:var(--credits-bad)}
/* 语义色要压得住组件自己的默认色（例如 .credits-pkg-due 的灰），统一抬高一层。 */
.credits-page .credits-tone-ok{color:var(--credits-ok)}
.credits-page .credits-tone-warn{color:var(--credits-warn)}
.credits-page .credits-tone-bad{color:var(--credits-bad)}

/* ---------- 调用方式 ---------- */
.credits-now{flex:none;padding:1px 9px;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;white-space:nowrap;border:1px solid color-mix(in oklab,var(--credits-fg) 26%,transparent);background:color-mix(in oklab,var(--credits-fg) 9%,transparent);color:var(--credits-fg)}
.credits-options{display:flex;flex-wrap:wrap;gap:8px}
.credits-option{appearance:none;font:inherit;flex:1 1 92px;min-width:0;cursor:pointer;text-align:left;display:flex;flex-direction:column;justify-content:center;gap:2px;min-height:42px;padding:7px 10px;border-radius:11px;border:1px solid color-mix(in oklab,var(--credits-line) 80%,transparent);background:transparent;color:var(--credits-fg3);transition:color .16s ease,border-color .16s ease,background .16s ease,box-shadow .16s ease}
.credits-option:hover:not(:disabled):not([data-active="true"]){color:var(--credits-fg2);border-color:color-mix(in oklab,var(--credits-dim) 70%,transparent);background:color-mix(in oklab,var(--credits-fg) 4%,transparent)}
.credits-option:focus-visible{outline:2px solid var(--credits-brand);outline-offset:1px}
.credits-option:disabled{opacity:.55;cursor:default}
.credits-option[data-active="true"]{background:var(--credits-raise);border-color:color-mix(in oklab,var(--credits-fg) 32%,transparent);box-shadow:inset 3px 0 0 var(--credits-fg);color:var(--credits-fg)}
.credits-option-top{display:flex;align-items:center;gap:6px;min-width:0}
.credits-option-name{font-size:12px;font-weight:600;line-height:16px;overflow-wrap:anywhere}
.credits-option-badge{flex:none;margin-left:auto;padding:0 6px;border-radius:999px;background:color-mix(in oklab,var(--credits-ok) 15%,transparent);color:var(--credits-ok);font-size:10px;font-weight:600;line-height:15px;white-space:nowrap}
/* 悬停才展开的说明：不悬停时四个按钮仍是一行，扫一眼就能比较。 */
.credits-option-note{display:block;max-height:0;opacity:0;overflow:hidden;font-size:10.5px;line-height:1.45;color:var(--credits-fg3);transition:max-height .18s ease,opacity .16s ease}
.credits-option:hover:not(:disabled) .credits-option-note,.credits-option:focus-visible .credits-option-note{max-height:6em;opacity:1}
.credits-option[data-active="true"] .credits-option-note{color:var(--credits-fg2)}

/* ---------- 账号卡 ---------- */
.credits-accounts{display:flex;flex-direction:column;gap:10px}
.credits-account{border-radius:13px;border:1px solid color-mix(in oklab,var(--credits-line) 70%,transparent);background:var(--credits-card);overflow:hidden;transition:border-color .18s ease,box-shadow .18s ease}
.credits-account:hover{border-color:color-mix(in oklab,var(--credits-dim) 55%,transparent);box-shadow:0 6px 20px rgba(0,0,0,.16)}
.credits-account[data-serving="true"]{border-color:color-mix(in oklab,var(--credits-ok) 42%,var(--credits-line));box-shadow:0 0 0 1px color-mix(in oklab,var(--credits-ok) 12%,transparent)}
.credits-account[data-offline="true"]{opacity:.72}
.credits-acc-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:10px 13px 0;cursor:pointer;user-select:none}
.credits-acc-head:focus-visible{outline:2px solid var(--credits-brand);outline-offset:-2px}
.credits-avatar{flex:none;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:650;color:#fff;letter-spacing:0}
.credits-acc-name{font-size:13.5px;font-weight:650;line-height:20px;letter-spacing:-.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.credits-acc-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:1px 13px 0;font-size:11px;line-height:16px;color:var(--credits-fg3);font-variant-numeric:tabular-nums}
.credits-acc-flux{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;padding:8px 13px 0}
.credits-flux{display:flex;flex-direction:column;gap:0;min-width:0}
.credits-flux b{font-size:14.5px;font-weight:650;line-height:19px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.credits-flux span{font-size:10.5px;line-height:14px;color:var(--credits-fg3);white-space:nowrap}
.credits-acc-bar{padding:9px 13px 12px}
.credits-acc-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 13px 10px}
.credits-acc-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
/* 改名在抽屉里就地改：浏览器自带的 prompt 在桌面端窗口里会被直接丢掉，点了没反应。 */
.credits-rename{display:flex;align-items:center;gap:7px;flex:1 1 200px;min-width:0}
.credits-rename-in{appearance:none;font:inherit;flex:1 1 auto;min-width:0;padding:4px 9px;border-radius:8px;font-size:12.5px;line-height:18px;background:var(--credits-bg);color:var(--credits-fg);border:1px solid color-mix(in oklab,var(--credits-brand) 55%,var(--credits-line));transition:border-color .16s ease,box-shadow .16s ease}
.credits-rename-in::placeholder{color:var(--credits-dim)}
.credits-rename-in:focus-visible{outline:2px solid var(--credits-brand);outline-offset:1px}
.credits-chevron{flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:6px;color:var(--credits-fg3);font-size:11px;line-height:1;transition:transform .26s cubic-bezier(.4,0,.2,1),color .16s ease,background .16s ease}
.credits-acc-head:hover .credits-chevron{color:var(--credits-fg);background:color-mix(in oklab,var(--credits-fg) 8%,transparent)}
.credits-chevron[data-open="true"]{transform:rotate(180deg)}

/* 展开区：grid-template-rows 从 0fr 到 1fr，高度动画不需要预先测量。 */
.credits-drawer{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s cubic-bezier(.4,0,.2,1)}
.credits-drawer[data-open="true"]{grid-template-rows:1fr}
.credits-drawer-in{overflow:hidden;min-height:0}
.credits-drawer-pad{display:flex;flex-direction:column;gap:9px;padding:2px 13px 12px;border-top:1px solid color-mix(in oklab,var(--credits-line) 45%,transparent);margin-top:2px}

/* ---------- 分段额度条 ---------- */
.credits-bar{display:flex;gap:2px;height:8px;border-radius:999px;overflow:hidden;background:color-mix(in oklab,var(--credits-fg) 7%,transparent);box-shadow:inset 0 1px 2px rgba(0,0,0,.18)}
.credits-bar-seg{height:100%;border-radius:2px;min-width:4px;flex-shrink:1;transition:flex-grow .35s ease,opacity .2s ease}
.credits-bar-seg:hover{filter:brightness(1.15)}
.credits-bar-empty{display:flex;align-items:center;height:7px;border-radius:999px;background:color-mix(in oklab,var(--credits-fg) 7%,transparent);font-size:9px;color:var(--credits-fg3);padding-left:6px}

/* ---------- 积分明细 ---------- */
.credits-pkgs{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none}
.credits-pkg{display:grid;grid-template-columns:8px 1fr auto;align-items:center;gap:8px;padding:6px 0;border-top:1px solid color-mix(in oklab,var(--credits-line) 32%,transparent)}
.credits-pkg:first-child{border-top:0}
.credits-pkg-dot{width:7px;height:7px;border-radius:2px;flex:none}
.credits-pkg-main{min-width:0;display:flex;flex-direction:column;gap:1px}
.credits-pkg-name{font-size:12px;line-height:17px;color:var(--credits-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.credits-pkg-sub{font-size:10.5px;line-height:14px;color:var(--credits-fg3);font-variant-numeric:tabular-nums}
.credits-pkg-right{display:flex;flex-direction:column;align-items:flex-end;gap:1px;font-variant-numeric:tabular-nums}
.credits-pkg-num{font-size:12px;font-weight:600;line-height:17px}
.credits-pkg-due{font-size:10.5px;line-height:14px;color:var(--credits-fg3);white-space:nowrap}
.credits-pkg[data-spent="true"] .credits-pkg-name,.credits-pkg[data-spent="true"] .credits-pkg-num{color:var(--credits-fg3);text-decoration:line-through;text-decoration-color:color-mix(in oklab,var(--credits-fg3) 60%,transparent)}

/* ---------- 徽标 ---------- */
.credits-badge{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border-radius:999px;font-size:10.5px;font-weight:600;line-height:18px;white-space:nowrap;border:1px solid transparent;background:color-mix(in oklab,var(--credits-fg) 8%,transparent);color:var(--credits-fg3)}
.credits-badge i{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.credits-badge-ok{background:color-mix(in oklab,var(--credits-ok) 13%,transparent);border-color:color-mix(in oklab,var(--credits-ok) 34%,transparent);color:var(--credits-ok)}
.credits-badge-warn{background:color-mix(in oklab,var(--credits-warn) 14%,transparent);border-color:color-mix(in oklab,var(--credits-warn) 34%,transparent);color:var(--credits-warn)}
.credits-badge-bad{background:color-mix(in oklab,var(--credits-bad) 13%,transparent);border-color:color-mix(in oklab,var(--credits-bad) 34%,transparent);color:var(--credits-bad)}
.credits-badge-live{background:color-mix(in oklab,var(--credits-ok) 8%,transparent);border-color:color-mix(in oklab,var(--credits-ok) 30%,transparent);color:var(--credits-ok);font-weight:650}
.credits-badge-live i{box-shadow:0 0 0 3px color-mix(in oklab,var(--credits-ok) 16%,transparent);animation:credits-pulse 2.4s ease-in-out infinite}

/* ---------- 动态 ---------- */
.credits-feed{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.credits-feed-row{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:9px;padding:7px 0;border-top:1px solid color-mix(in oklab,var(--credits-line) 34%,transparent)}
.credits-feed-row:first-child{border-top:0}
.credits-feed-dot{width:6px;height:6px;border-radius:50%;background:var(--credits-fg3);justify-self:center}
.credits-feed-main{display:flex;flex-direction:column;gap:0;min-width:0}
.credits-feed-name{font-size:12px;line-height:17px;color:var(--credits-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.credits-feed-when{font-size:10.5px;line-height:14px;color:var(--credits-fg3);font-variant-numeric:tabular-nums}

/* ---------- 使用看板 ---------- */
.credits-usage{display:flex;flex-direction:column;gap:12px}
.credits-usage-row{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:1px solid color-mix(in oklab,var(--credits-line) 40%,transparent)}
.credits-usage-row:first-child{padding-top:0;border-top:0}
.credits-usage-head{display:flex;align-items:center;gap:8px;min-width:0}
.credits-usage-name{font-size:12.5px;font-weight:600;line-height:18px;color:var(--credits-fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.credits-usage-head .credits-aside{margin-left:auto}
.credits-usage-bar{display:flex;gap:2px;height:8px;border-radius:999px;overflow:hidden;background:color-mix(in oklab,var(--credits-line) 55%,transparent)}
.credits-usage-seg{flex-basis:0;min-width:2px;border-radius:999px;transition:flex-grow .3s ease}
.credits-usage-models{display:flex;flex-wrap:wrap;gap:4px 10px}
.credits-model{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;line-height:15px;color:var(--credits-fg3);min-width:0}
.credits-model-dot{flex:none;width:6px;height:6px;border-radius:2px}
.credits-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:132px}
.credits-model-count{font-variant-numeric:tabular-nums;color:var(--credits-fg2)}
.credits-daily{display:flex;align-items:flex-end;gap:6px;height:72px;padding-top:4px}
.credits-daily-col{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px}
.credits-daily-bar{width:100%;max-width:26px;border-radius:4px 4px 2px 2px;background:color-mix(in oklab,var(--credits-brand) 62%,transparent);transition:height .3s ease}
.credits-daily-k{font-size:9.5px;line-height:12px;color:var(--credits-fg3);font-variant-numeric:tabular-nums;white-space:nowrap}

/* ---------- 对话头部账号选择 ---------- */
.credits-pick{position:relative;display:inline-flex;font-size:12px}
.credits-pick-btn{appearance:none;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px;max-width:190px;height:24px;padding:0 7px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0);transition:background .16s ease,border-color .16s ease,color .16s ease}
.credits-pick-btn:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary,#e6e6e6) 8%,transparent);border-color:color-mix(in oklab,var(--dsw-alias-border-l2,#36373b) 80%,transparent);color:var(--dsw-alias-label-primary,#e6e6e6)}
.credits-pick-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.credits-pick-btn[data-pinned="true"]{border-color:color-mix(in oklab,var(--dsw-alias-brand-primary,#5686fe) 45%,transparent);background:color-mix(in oklab,var(--dsw-alias-brand-primary,#5686fe) 12%,transparent);color:var(--dsw-alias-label-primary,#e6e6e6)}
.credits-pick-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22a06b)}
.credits-pick-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.credits-pick-caret{flex:none;font-size:9px;line-height:1;opacity:.6}
.credits-pick-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:40;width:264px;max-height:340px;overflow-y:auto;padding:5px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:0 14px 36px rgba(0,0,0,.4);animation:credits-rise .16s ease-out}
.credits-pick-head{padding:5px 8px 6px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.credits-pick-item{appearance:none;font:inherit;cursor:pointer;display:flex;align-items:center;gap:7px;width:100%;padding:6px 8px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0);text-align:left;transition:background .14s ease,color .14s ease}
.credits-pick-item:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary,#e6e6e6) 8%,transparent);color:var(--dsw-alias-label-primary,#e6e6e6)}
.credits-pick-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-1px}
.credits-pick-item[data-active="true"]{background:color-mix(in oklab,var(--dsw-alias-brand-primary,#5686fe) 14%,transparent);color:var(--dsw-alias-label-primary,#e6e6e6)}
.credits-pick-avatar{flex:none;width:18px;height:18px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:650;color:#fff}
.credits-pick-text{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}
.credits-pick-label{font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.credits-pick-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#9aa0a8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.credits-pick-check{flex:none;font-size:11px;color:var(--dsw-alias-brand-primary,#5686fe)}
.credits-pick-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2,#36373b)}

/* ---------- 自动化 ---------- */
.credits-switch{appearance:none;font:inherit;position:relative;flex:none;width:38px;height:21px;padding:0;border-radius:999px;cursor:pointer;border:1px solid color-mix(in oklab,var(--credits-line) 90%,transparent);background:var(--credits-raise);transition:background .2s ease,border-color .2s ease,box-shadow .2s ease}
.credits-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .24s cubic-bezier(.4,0,.2,1)}
.credits-switch[data-on="true"]{background:var(--credits-ok);border-color:transparent;box-shadow:0 0 0 3px color-mix(in oklab,var(--credits-ok) 14%,transparent)}
.credits-switch[data-on="true"]::after{transform:translateX(17px)}
.credits-switch:focus-visible{outline:2px solid var(--credits-brand);outline-offset:2px}
.credits-switch:disabled{opacity:.5;cursor:default}
.credits-field{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:2px 0}
.credits-field-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.credits-field-name{font-size:12.5px;line-height:18px;color:var(--credits-fg2)}
.credits-field-note{font-size:10.5px;line-height:15px;color:var(--credits-fg3)}
.credits-time{appearance:none;font:inherit;cursor:pointer;padding:4px 8px;border-radius:8px;border:1px solid color-mix(in oklab,var(--credits-line) 90%,transparent);background:var(--credits-raise);color:var(--credits-fg);font-size:12.5px;line-height:18px;font-variant-numeric:tabular-nums;transition:border-color .16s ease,background .16s ease}
.credits-time:hover:not(:disabled){border-color:color-mix(in oklab,var(--credits-dim) 70%,transparent)}
.credits-time:focus-visible{outline:2px solid var(--credits-brand);outline-offset:1px}
.credits-models{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:6px}
.credits-model{display:flex;align-items:center;gap:7px;padding:6px 9px;border-radius:9px;border:1px solid color-mix(in oklab,var(--credits-line) 62%,transparent);background:var(--credits-bg);cursor:pointer;min-width:0;transition:border-color .16s ease,background .16s ease}
.credits-model:hover{border-color:color-mix(in oklab,var(--credits-dim) 60%,transparent)}
.credits-model[data-on="true"]{border-color:color-mix(in oklab,var(--credits-brand) 46%,transparent);background:color-mix(in oklab,var(--credits-brand) 10%,transparent)}
.credits-model-in{appearance:none;flex:0 0 auto;width:13px;height:13px;margin:0;border-radius:4px;border:1px solid color-mix(in oklab,var(--credits-dim) 80%,transparent);background:transparent;cursor:pointer;position:relative;transition:border-color .16s ease,background .16s ease}
.credits-model-in:checked{border-color:var(--credits-brand);background:var(--credits-brand)}
.credits-model-in:checked::after{content:"";position:absolute;left:3.5px;top:0.5px;width:3px;height:6px;border-right:1.6px solid var(--credits-bg);border-bottom:1.6px solid var(--credits-bg);transform:rotate(40deg)}
.credits-model-in:focus-visible{outline:2px solid var(--credits-brand);outline-offset:2px}
.credits-model-in:disabled{cursor:default;opacity:.55}
.credits-model-name{font-size:12px;line-height:17px;color:var(--credits-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.credits-model[data-on="true"] .credits-model-name{color:var(--credits-fg)}
.credits-model-id{font-size:10px;line-height:14px;color:var(--credits-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:auto;flex:0 1 auto}
.credits-login{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:9px 11px;border-radius:10px;border:1px solid color-mix(in oklab,var(--credits-brand) 32%,transparent);background:color-mix(in oklab,var(--credits-brand) 9%,transparent);font-size:11.5px;color:var(--credits-fg2);animation:credits-rise .24s ease-out}
.credits-login a{color:var(--credits-brand);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.credits-login a:hover{text-decoration:underline}

/* ---------- 提示条 ---------- */
.credits-toast{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:10px;font-size:12px;line-height:18px;border:1px solid color-mix(in oklab,var(--credits-ok) 34%,transparent);background:color-mix(in oklab,var(--credits-ok) 10%,transparent);color:var(--credits-fg2);animation:credits-rise .24s cubic-bezier(.4,0,.2,1)}
.credits-toast[data-kind="error"]{border-color:color-mix(in oklab,var(--credits-bad) 38%,transparent);background:color-mix(in oklab,var(--credits-bad) 10%,transparent)}
.credits-toast-glyph{flex:none;font-size:11px}

/* ---------- 骨架屏 ---------- */
.credits-skel{border-radius:13px;border:1px solid color-mix(in oklab,var(--credits-line) 55%,transparent);background:linear-gradient(100deg,var(--credits-card) 30%,var(--credits-raise) 48%,var(--credits-card) 66%);background-size:280% 100%;animation:credits-shimmer 1.5s ease-in-out infinite}
.credits-spin{display:inline-block;animation:credits-rotate .85s linear infinite}

/* ---------- 侧边栏入口 ---------- */
.credits-side{appearance:none;font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;text-align:left;transition:background .16s ease,border-color .16s ease}
.credits-side:hover{background:color-mix(in oklab,var(--credits-fg) 8%,transparent);border-color:color-mix(in oklab,var(--credits-line) 70%,transparent)}
.credits-side:focus-visible{outline:2px solid var(--credits-brand);outline-offset:1px}
.credits-side-glyph{flex:none;width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;background:linear-gradient(135deg,#5686fe,#8b5cf6)}
.credits-side-text{display:flex;flex-direction:column;gap:0;min-width:0}
.credits-side-main{font-size:11.5px;font-weight:600;line-height:15px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.credits-side-sub{font-size:10px;line-height:13px;color:var(--credits-fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.credits-side-dot{flex:none;width:6px;height:6px;border-radius:50%}

@keyframes credits-rotate{to{transform:rotate(360deg)}}
@keyframes credits-rise{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
@keyframes credits-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
@keyframes credits-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes credits-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.credits-in{animation:credits-in .24s cubic-bezier(.4,0,.2,1)}

@media (prefers-reduced-motion: reduce){
  .credits-page *,.credits-page *::before,.credits-page *::after{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important}
}
`

		/**
		 * 把样式表挂到 document.head。
		 *
		 * 客户端插件被重载时同一张表会被再次调用，所以先按 `data-plugin-css` 查旧节点：
		 * 有就更新文本、没有才新建，热重载后不会留下一堆同名 style。
		 */
		function ensureStyles() {
			if (typeof document === 'undefined' || document.head === null) return
			try {
				const existing = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
				if (existing !== null) {
					existing.textContent = PANEL_CSS
					return
				}
				const tag = document.createElement('style')
				tag.dataset.plugin = PACKAGE_NAME
				tag.dataset.pluginCss = CSS_ID
				tag.textContent = PANEL_CSS
				document.head.appendChild(tag)
			} catch (failure) {
				console.error('[multi-credits-pool] 样式注入失败（界面仍可用，只是没有动效）：', failure)
			}
		}

		ensureStyles()

		async function call(path, init) {
			const response = await fetch(`${WEB_BASE}${path}`, init)
			let body = {}
			try {
				body = await response.json()
			} catch {
				body = {}
			}
			if (!response.ok) throw new Error(body.error ?? body.message ?? `HTTP ${response.status}`)
			if (body.ok === false) throw new Error(body.message ?? '操作失败')
			return body
		}

		function loadState() {
			return call('/state')
		}

		/**
		 * 看板、侧边栏、对话头三处显示的是同一份状态，必须一处刷新处处同步。
		 *
		 * 各自 `useEffect` 拉一次的做法只在挂载时正确：看板刷新完侧边栏还是旧数字，
		 * 只有重开窗口（重挂载）才对得上。这里用一个模块级的状态通道——谁拉到新状态就
		 * 推给所有订阅者，侧边栏与看板因此永远同源。
		 */
		const stateListeners = new Set()
		let sharedState

		function publishState(next) {
			sharedState = next
			for (const listener of stateListeners) {
				try {
					listener(next)
				} catch {
					// 某个订阅者渲染出错不该堵住其它订阅者。
				}
			}
		}

		function subscribeState(listener) {
			stateListeners.add(listener)
			return () => stateListeners.delete(listener)
		}

		/** 拉一份最新状态并广播；调用方拿到的就是刚广播的那份。 */
		async function loadSharedState() {
			const next = await loadState()
			publishState(next)
			return next
		}

		async function act(actionKey, payload) {
			return call('/action', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Credits-Key': actionKey },
				body: JSON.stringify(payload),
			})
		}

		/** 今日状态 → 文案与语义色调。 */
		const TODAY = {
			claimed: { text: '今日已签到', tone: 'ok' },
			already: { text: '今天已签过', tone: 'plain' },
			'no-campaign': { text: '活动未开启', tone: 'warn' },
			pending: { text: '未签到', tone: 'warn' },
			error: { text: '签到失败', tone: 'bad' },
		}

		/** 剩余占比 → 语义色调类名：40% 以上绿、15% 以上黄、其余红。 */
		function ratioTone(ratio) {
			if (typeof ratio !== 'number') return ''
			return ratio > 0.4 ? ' credits-tone-ok' : ratio > 0.15 ? ' credits-tone-warn' : ' credits-tone-bad'
		}

		/** 距今还有多久，用于「3 天后过期」这类文案。 */
		function untilText(ms) {
			const days = Math.ceil((ms - Date.now()) / 86_400_000)
			if (days <= 0) return '已过期'
			if (days === 1) return '明天到期'
			if (days < 30) return `${days} 天后到期`
			return `${Math.round(days / 30)} 个月后到期`
		}

		/**
		 * 到期日的紧迫度：一周内红、一月内黄、其余中性。
		 *
		 * 三段积分可能同一天到期，颜色是唯一能在扫视时把「快作废的」挑出来的东西。
		 */
		function expiryTone(ms) {
			if (!Number.isFinite(ms)) return ''
			const days = (ms - Date.now()) / 86_400_000
			if (days <= 7) return ' credits-tone-bad'
			if (days <= 30) return ' credits-tone-warn'
			return ''
		}

		function formatNumber(value) {
			return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
		}

		/** 相对时间：刚刚 / N 分钟前 / N 小时前 / M-D HH:mm。 */
		function relativeTime(isoText) {
			if (typeof isoText !== 'string') return ''
			const at = Date.parse(isoText)
			if (Number.isNaN(at)) return ''
			const minutes = Math.round((Date.now() - at) / 60_000)
			if (minutes < 1) return '刚刚'
			if (minutes < 60) return `${minutes} 分钟前`
			if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`
			const date = new Date(at)
			return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
		}

		/** 令牌剩余天数文案。 */
		function tokenText(expiresAtMs) {
			if (typeof expiresAtMs !== 'number') return '令牌无到期信息'
			const days = Math.ceil((expiresAtMs - Date.now()) / 86_400_000)
			if (days <= 0) return '令牌已过期'
			return `令牌 ${days} 天`
		}

		/** 冷却剩余文案。 */
		function cooldownText(cooldownUntil) {
			if (typeof cooldownUntil !== 'number') return undefined
			const minutes = Math.max(1, Math.round((cooldownUntil - Date.now()) / 60_000))
			return minutes >= 60 ? `冷却 ${Math.round(minutes / 60)} 小时` : `冷却 ${minutes} 分钟`
		}

		function minuteText(minuteOfDay) {
			const value = Number.isInteger(minuteOfDay) ? minuteOfDay : 600
			return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
		}

		/** 毫秒时刻按本地墙上时间显示成「M-D HH:mm」，与对话里看到的时刻一致。 */
		function clockText(atMs) {
			if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) return ''
			const date = new Date(atMs)
			return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
		}

		/** 一段积分的百分比：不限量或总量未知时返回 undefined，绝不假装 100%。 */
		function percentOf(remain, size, unlimited) {
			if (unlimited === true) return undefined
			if (!(size > 0)) return undefined
			return Math.min(1, Math.max(0, remain / size))
		}

		/** 「还剩多少」的统一文案。 */
		function remainText(remain, size, unlimited) {
			if (unlimited === true) return '不限量'
			const left = formatNumber(remain)
			return size > 0 ? `${left} / ${formatNumber(size)}` : left
		}

		function initialOf(row) {
			const source = typeof row.label === 'string' && row.label !== '' ? row.label : row.id
			return String(source ?? '?').trim().slice(0, 1).toUpperCase() || '?'
		}

		/** 账号 id 的稳定散列：同一个账号换机器、换会话都是同一个颜色。 */
		function gradientOf(id) {
			let hash = 0
			for (let index = 0; index < String(id).length; index += 1) hash = (hash * 31 + String(id).charCodeAt(index)) % 99991
			return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]
		}

		/** 一段积分的颜色：一周内红、一月内黄、其余绿，读不到到期时间用中性灰。 */
		function segmentColor(pkg) {
			const ms = pkg?.endTimeMs
			if (!Number.isFinite(ms)) return EXPIRY_COLORS.unknown
			const days = (ms - Date.now()) / 86_400_000
			if (days <= 7) return EXPIRY_COLORS.soon
			if (days <= 30) return EXPIRY_COLORS.near
			return EXPIRY_COLORS.far
		}

		/* ================= 基础件 ================= */

		function Badge(props) {
			const kind = props.tone === undefined || props.tone === 'plain' ? '' : ` credits-badge-${props.tone}`
			return h('span', { className: `credits-badge${kind}`, title: props.title }, props.dot === true ? h('i', null) : null, props.children)
		}

		function Btn(props) {
			const extra = props.kind === 'primary' ? ' credits-btn-primary' : props.kind === 'ghost' ? ' credits-btn-ghost' : props.kind === 'icon' ? ' credits-btn-icon' : props.kind === 'danger' ? ' credits-btn-danger' : ''
			return h(
				'button',
				{
					type: 'button',
					className: `credits-btn${extra}`,
					disabled: props.disabled === true,
					onClick: props.onClick,
					title: props.title,
					'aria-label': props.label,
				},
				props.spin === true ? h('span', { className: 'credits-spin' }, '◌') : null,
				props.children,
			)
		}

		function Toast(props) {
			return h(
				'div',
				{ className: 'credits-toast', 'data-kind': props.kind ?? 'notice', role: 'status' },
				h('span', { className: 'credits-toast-glyph' }, props.kind === 'error' ? '✕' : '✓'),
				h('span', null, props.children),
			)
		}

		/* ================= 概览 ================= */

		/** 四个关键读数。数字是主角，说明文字压在下面一行。 */
		function Stats(props) {
			const totals = props.totals
			const loading = totals === undefined
			const items = [
				{ k: '剩余积分', v: loading ? '—' : formatNumber(totals.creditsRemaining), h: loading ? '' : `${totals.accounts} 个账号合计` },
				{ k: '今日获得', v: loading ? '—' : `+${formatNumber(totals.claimedToday)}`, h: '今天签到所得', tone: loading ? '' : ' credits-tone-ok' },
				{ k: '本月累计', v: loading ? '—' : `+${formatNumber(totals.claimedMonth)}`, h: loading ? '' : `自 ${props.month ?? '本月'} 起` },
				{
					k: '今日已签',
					v: loading ? '—' : `${totals.checkedIn}/${totals.accounts}`,
					h: loading ? '' : totals.accounts > 0 && totals.checkedIn === totals.accounts ? '全部签完' : `${totals.accounts - totals.checkedIn} 个待签`,
					tone: loading ? '' : totals.accounts > 0 && totals.checkedIn === totals.accounts ? ' credits-tone-ok' : ' credits-tone-warn',
				},
			]
			return h(
				'div',
				{ className: 'credits-card' },
				h(
					'div',
					{ className: 'credits-card-head' },
					h('h2', { className: 'credits-label' }, '用量'),
					h('span', { className: 'credits-aside' }, props.generatedAt === undefined ? '读取中…' : `读数 ${relativeTime(new Date(props.generatedAt).toISOString()) || '刚刚'}`),
				),
				h(
					'div',
					{ className: 'credits-stats' },
					items.map(item =>
						h(
							'div',
							{ key: item.k, className: 'credits-stat', title: item.h },
							h('span', { className: 'credits-stat-k' }, item.k),
							h('span', { className: `credits-stat-v${item.tone ?? ''}` }, item.v),
							h('span', { className: 'credits-stat-h' }, item.h),
						),
					),
				),
			)
		}

		/* ================= 调用方式 ================= */

		/**
		 * 账号调用方式：四个选项 + 当前模式的说明。
		 *
		 * 只做展示与下发，排序真正发生在代理进程里（`src/rotation.js`），
		 * 所以切换后不需要重启，下一个请求就按新模式走。
		 *
		 * 每个选项都带 `title`，鼠标停上去就有系统气泡；同时把说明区换成
		 * 悬停/聚焦的那一项——气泡会消失，说明区不会，用户能对着读代价。
		 */
		function StrategyCard(props) {
			const data = props.data
			const active = data.state?.config?.strategy ?? 'sticky'
			const bound = data.state?.rotation?.boundConversations
			const current = STRATEGY_OPTIONS.find(item => item.id === active) ?? STRATEGY_OPTIONS[0]
			const [peek, setPeek] = react.useState(null)
			const shown = STRATEGY_OPTIONS.find(item => item.id === peek) ?? current
			return h(
				'div',
				{ className: 'credits-card' },
				h(
					'div',
					{ className: 'credits-card-head' },
					h('h2', { className: 'credits-label' }, '账号调用方式'),
					h('span', { className: 'credits-now' }, `当前：${current.label}`),
				),
				h(
					'div',
					{ className: 'credits-options', role: 'radiogroup', 'aria-label': '账号调用方式' },
					STRATEGY_OPTIONS.map(item =>
						h(
							'button',
							{
								key: item.id,
								type: 'button',
								role: 'radio',
								'aria-checked': item.id === active,
								className: 'credits-option',
								'data-active': item.id === active ? 'true' : 'false',
								// 悬停气泡：一句话说清这个模式怎么选账号、代价是什么。
								title: item.hint,
								disabled: data.busy,
								onMouseEnter: () => setPeek(item.id),
								onMouseLeave: () => setPeek(null),
								onFocus: () => setPeek(item.id),
								onBlur: () => setPeek(null),
								onClick: () => {
									if (item.id !== active) void data.actions.strategy(item.id)
								},
							},
							h(
								'span',
								{ className: 'credits-option-top' },
								h('span', { className: 'credits-option-name' }, item.label),
								item.recommended === true ? h('span', { className: 'credits-option-badge' }, '推荐') : null,
							),
							h('span', { className: 'credits-option-note', 'aria-hidden': 'true' }, item.hint),
						),
					),
				),
				h(
					'p',
					{ className: 'credits-hint', 'data-peek': shown.id === active ? 'false' : 'true' },
					h('b', { className: 'credits-hint-name' }, shown.label),
					`：${shown.hint}`,
				),
				typeof bound === 'number' && bound > 0
					? h(
							'p',
							{ className: 'credits-hint' },
							`已固定 ${bound} 段对话：这些对话的下一次请求优先回到它原来用的账号。要换某个对话的账号，用对话标题栏右侧的账号按钮。`,
						)
					: null,
			)
		}

		/* ================= 分段额度条 ================= */

		/**
		 * 分段额度条：每段积分按剩余量占一段宽度，颜色是这段积分的身份色。
		 *
		 * 单条总进度条回答不了「哪一段先作废」——把每段拆成独立小段，
		 * 宽度是剩余量、颜色与下面明细行的圆点一一对应，扫一眼就知道额度是集中在
		 * 长周期还是碎在一堆短期包里。用完的段不占宽度，避免一块黑区把条子压扁。
		 */
		function CreditBar(props) {
			const packages = Array.isArray(props.packages) ? props.packages : []
			const live = packages.filter(pkg => pkg.unlimited !== true && pkg.remain > 0).sort((a, b) => (a.endTimeMs ?? Infinity) - (b.endTimeMs ?? Infinity))
			const unlimited = packages.some(pkg => pkg.unlimited === true)
			if (unlimited) {
				return h('div', { className: 'credits-bar' }, h('span', { className: 'credits-bar-seg', style: { flex: '1 1 0', background: EXPIRY_COLORS.far }, title: '不限量' }))
			}
			if (live.length === 0) {
				return h('div', { className: 'credits-bar', title: '没有可用积分段' })
			}
			const total = live.reduce((sum, pkg) => sum + Math.max(0, pkg.remain), 0)
			return h(
				'div',
				{ className: 'credits-bar', role: 'img', 'aria-label': props.label ?? '积分分段占比' },
				live.map((pkg, index) => {
					// flex-grow 用「占剩余总量的比例」当权重，而不是百分比：每项 basis 为 0，
					// 权重之间直接按比例分宽度，太小的段靠 min-width 兜住可见性。
					const share = total > 0 ? Math.max(0, pkg.remain) / total : 1 / live.length
					return h('span', {
						key: `${pkg.code ?? pkg.name}-${index}`,
						className: 'credits-bar-seg',
						title: `${pkg.name}：${remainText(pkg.remain, pkg.size, pkg.unlimited)}${pkg.endTime === undefined ? '' : ` · ${pkg.endTime} 到期`}`,
						style: {
							flexGrow: String(share),
							background: segmentColor(pkg),
						},
					})
				}),
			)
		}

		/**
		 * 逐段积分明细。
		 *
		 * 每段一行——套餐名、剩余/总量、到期时间与倒计时。同名套餐不合并：
		 * 合并后就看不出「裂变包 5 份、各差一天到期」这件事，而这正是要解决的问题。
		 * 有余额的按到期时间升序（先作废的排最上面），用完的沉底并划掉。
		 */
		function PackageLedger(props) {
			const packages = Array.isArray(props.packages) ? props.packages : []
			if (packages.length === 0) {
				return h('div', { className: 'credits-hint' }, '这个账号没有报告积分分段。')
			}
			const now = Date.now()
			const live = []
			const spent = []
			for (const pkg of packages) {
				if (pkg.remain > 0 || pkg.unlimited === true) live.push(pkg)
				else spent.push(pkg)
			}
			live.sort((a, b) => (a.endTimeMs ?? Infinity) - (b.endTimeMs ?? Infinity))
			const ordered = [...live, ...spent]
			return h(
				'ul',
				{ className: 'credits-pkgs' },
				ordered.map((pkg, index) => {
					const isSpent = pkg.remain <= 0 && pkg.unlimited !== true
					// 一份没用过的积分包写「已用 0」是噪音：用掉了才值得说一句用掉多少。
					const used = pkg.unlimited === true ? 0 : Number(pkg.used ?? Math.max(0, (pkg.size ?? 0) - pkg.remain))
					const sub = pkg.unlimited === true ? '不限量' : used > 0 ? `已用 ${formatNumber(used)}` : undefined
					return h(
						'li',
						{ key: `${pkg.code ?? pkg.name}-${index}`, className: 'credits-pkg', 'data-spent': isSpent ? 'true' : 'false' },
						h('span', { className: 'credits-pkg-dot', style: { background: isSpent ? 'var(--credits-dim)' : segmentColor(pkg) } }),
						h(
							'span',
							{ className: 'credits-pkg-main' },
							h('span', { className: 'credits-pkg-name', title: pkg.name }, pkg.name),
							sub === undefined ? null : h('span', { className: 'credits-pkg-sub' }, sub),
						),
						h(
							'span',
							{ className: 'credits-pkg-right' },
							h('span', { className: `credits-pkg-num${isSpent ? '' : ratioTone(percentOf(pkg.remain, pkg.size, pkg.unlimited))}` }, remainText(pkg.remain, pkg.size, pkg.unlimited)),
							h(
								'span',
								{ className: `credits-pkg-due${isSpent ? '' : expiryTone(pkg.endTimeMs)}`, title: pkg.endTime ?? '无到期时间' },
								isSpent ? '已用完' : Number.isFinite(pkg.endTimeMs) ? untilText(pkg.endTimeMs) : '无到期时间',
							),
						),
					)
				}),
			)
		}

		/* ================= 账号卡 ================= */

		/**
		 * 账号卡：收起时一行身份 + 三个读数 + 分段额度条，点开看逐段明细。
		 *
		 * 展开态由父组件持有（`expandedId`），所以刷新后不会自己弹回去；
		 * 同一时刻只展开一个，账号多时不会把面板撑成一长条。
		 */
		function AccountRow(props) {
			const row = props.row
			const busy = props.busy
			const today = TODAY[row.today] ?? TODAY.pending
			const cooldown = cooldownText(row.cooldownUntil)
			const ratio = percentOf(row.credits, row.creditsTotal, row.unlimited)
			const regionText = row.region === 'global' ? '国际' : '国内'
			const meta = [
				regionText,
				row.uidSuffix === undefined ? undefined : `uid ····${row.uidSuffix}`,
				row.enterprise === true ? '企业额度' : undefined,
				tokenText(row.expiresAtMs),
			].filter(Boolean)

			return h(
				'article',
				{
					className: 'credits-account',
					'data-serving': props.serving === true ? 'true' : 'false',
					'data-offline': row.error === undefined ? 'false' : 'true',
				},
				h(
					'div',
					{
						className: 'credits-acc-head',
						role: 'button',
						tabIndex: 0,
						'aria-expanded': props.expanded === true,
						onClick: () => props.onToggle(row.id),
						onKeyDown: event => {
							if (event.key !== 'Enter' && event.key !== ' ') return
							event.preventDefault()
							props.onToggle(row.id)
						},
					},
					h('span', { className: 'credits-avatar', style: { background: gradientOf(row.id) } }, initialOf(row)),
					h('span', { className: 'credits-acc-name', title: row.label ?? row.id }, row.label ?? row.id),
					props.serving === true ? h(Badge, { tone: 'live', dot: true }, '下一个出账') : null,
					row.nickname !== undefined && row.nickname !== '' ? h(Badge, null, row.nickname) : null,
					h('span', { style: { flex: 1 } }),
					cooldown === undefined ? null : h(Badge, { tone: 'warn', dot: true }, cooldown),
					h(Badge, { tone: today.tone, dot: today.tone !== 'plain' }, cooldown === undefined ? today.text : '暂不参与'),
					h('span', { className: 'credits-chevron', 'data-open': props.expanded === true ? 'true' : 'false', 'aria-hidden': 'true' }, '⌄'),
				),
				h('div', { className: 'credits-acc-meta' }, meta.join(' · ')),
				h(
					'div',
					{ className: 'credits-acc-flux' },
					h('span', { className: 'credits-flux' }, h('b', { className: ratioTone(ratio) }, formatNumber(row.credits)), h('span', null, '剩余积分')),
					h('span', { className: 'credits-flux' }, h('b', null, row.amount === undefined ? '—' : `+${formatNumber(row.amount)}`), h('span', null, '今日获得')),
					h('span', { className: 'credits-flux' }, h('b', null, row.unlimited === true ? '不限量' : formatNumber(row.creditsTotal)), h('span', null, '额度总量')),
					props.rank !== undefined && props.rank > 0 ? h('span', { className: 'credits-flux' }, h('b', null, `第 ${props.rank + 1} 顺位`), h('span', null, '出账顺序')) : null,
				),
				h('div', { className: 'credits-acc-bar' }, h(CreditBar, { packages: row.packages, label: `${row.label ?? row.id} 的积分分段` })),
				h(
					'div',
					{ className: 'credits-drawer', 'data-open': props.expanded === true ? 'true' : 'false' },
					h(
						'div',
						{ className: 'credits-drawer-in' },
						h(
							'div',
							{ className: 'credits-drawer-pad' },
							row.packages !== undefined && row.packages.length > 0 ? h(PackageLedger, { packages: row.packages }) : null,
							row.error !== undefined
								? h('p', { className: 'credits-hint credits-hint-bad' }, row.error)
								: row.packages === undefined || row.packages.length === 0
									? h('p', { className: 'credits-hint' }, '这个账号没有报告积分分段。')
									: null,
							row.message !== undefined && row.message !== '' && row.message !== row.error ? h('p', { className: 'credits-hint' }, row.message) : null,
							h(
								'div',
								{ className: 'credits-acc-actions' },
								props.renaming === true
									? h(
											'span',
											{ className: 'credits-rename' },
											h('input', {
												type: 'text',
												className: 'credits-rename-in',
												value: props.draft ?? '',
												placeholder: '新的账号名',
												'aria-label': '账号名',
												autoFocus: true,
												onChange: event => props.onRenameDraft(event.target.value),
												onKeyDown: event => {
													if (event.key === 'Enter') {
														event.preventDefault()
														props.onRenameSubmit(row)
													} else if (event.key === 'Escape') {
														event.preventDefault()
														props.onRenameCancel()
													}
												},
											}),
											h(Btn, { kind: 'primary', disabled: busy || String(props.draft ?? '').trim() === '', onClick: () => props.onRenameSubmit(row) }, '保存'),
											h(Btn, { kind: 'ghost', disabled: busy, onClick: () => props.onRenameCancel() }, '取消'),
										)
									: [
											h(Btn, { key: 'checkin', disabled: busy, onClick: () => props.onCheckin(row.id) }, '签到'),
											h(Btn, { key: 'rename', disabled: busy, onClick: () => props.onRenameStart(row) }, '改名'),
											h(Btn, { key: 'remove', kind: 'danger', disabled: busy, onClick: () => props.onRemove(row) }, '移除'),
										],
								h('span', { style: { flex: 1 } }),
								h('span', { className: 'credits-aside' }, tokenText(row.expiresAtMs)),
							),
						),
					),
				),
			)
		}

		/* ================= 动态 ================= */

		function Feed(props) {
			const entries = Array.isArray(props.entries) ? props.entries : []
			if (entries.length === 0) {
				return h('div', { className: 'credits-empty' }, h('span', { className: 'credits-empty-glyph' }, '⟳'), h('span', null, '还没有签到记录。'), h('span', null, '签到之后这里会留下每一条流水。'))
			}
			return h(
				'ul',
				{ className: 'credits-feed' },
				entries.slice(0, RECENT_LIMIT).map((entry, index) => {
					const claimed = entry.status === 'claimed'
					return h(
						'li',
						{ key: `${entry.at}-${entry.accountId}-${index}`, className: 'credits-feed-row' },
						h('span', { className: 'credits-feed-dot', style: { background: claimed ? 'var(--credits-ok)' : entry.status === 'error' ? 'var(--credits-bad)' : 'var(--credits-fg3)' } }),
						h(
							'span',
							{ className: 'credits-feed-main' },
							h('span', { className: 'credits-feed-name' }, entry.label ?? entry.accountId),
							h('span', { className: 'credits-feed-when' }, relativeTime(entry.at) || entry.date || ''),
						),
						h(
							Badge,
							{ tone: claimed ? 'ok' : entry.status === 'error' ? 'bad' : 'plain' },
							claimed ? `+${formatNumber(entry.amount)}` : entry.status === 'already-claimed' ? '已签过' : entry.status === 'no-campaign' ? '活动未开启' : '失败',
						),
					)
				}),
			)
		}

		/* ================= 使用看板 ================= */

		/** 模型名的短写：前缀相同的模型放在一起比较时长名会把格子撑爆。 */
		function shortModel(model) {
			const text = typeof model === 'string' && model !== '' ? model : 'unknown'
			return text.length > 18 ? `${text.slice(0, 17)}…` : text
		}

		/**
		 * 使用看板：按账号 × 模型看请求落在谁身上。
		 *
		 * 数据来自代理进程每次请求落的一行流水（`src/usage.js`）。这里只做聚合后的
		 * 展示——每个账号用了多少请求、失败几条、分别打了哪些模型，比例用一条横条
		 * 表示，扫一眼就能看出「钱花在哪个账号的哪个模型上」。
		 */
		function UsageBoard(props) {
			const usage = props.usage
			const rows = Array.isArray(props.rows) ? props.rows : []
			const accounts = Array.isArray(usage?.accounts) ? usage.accounts : []
			const labelOf = id => rows.find(row => row.id === id)?.label ?? id
			const total = typeof usage?.total === 'number' ? usage.total : 0
			const failed = typeof usage?.failed === 'number' ? usage.failed : 0
			const days = typeof usage?.days === 'number' ? usage.days : 0

			if (accounts.length === 0) {
				return h(
					'div',
					{ className: 'credits-card credits-in' },
					h('div', { className: 'credits-card-head' }, h('h2', { className: 'credits-label' }, '使用看板'), h('span', { className: 'credits-aside' }, `近 ${days} 天`)),
					h(
						'div',
						{ className: 'credits-empty' },
						h('span', { className: 'credits-empty-glyph' }, '◔'),
						h('span', null, '近 ' + days + ' 天还没有请求。'),
						h('span', null, '这里只统计走「multi-credits-pool」通道的请求。对话如果选的是别的 provider，请求不经过本代理，就不会有记录。'),
						h('span', null, '在模型选择器里选 multi-credits-pool 下的模型，下一次请求就会出现在这里。'),
					),
				)
			}

			const stats = [
				{ k: '请求总数', v: formatNumber(total), h: `近 ${days} 天` },
				{ k: '失败请求', v: formatNumber(failed), h: total > 0 ? `${Math.round((failed / total) * 100)}% 走过了故障转移` : '无失败', tone: failed > 0 ? ' credits-tone-warn' : '' },
				{ k: '输入 token', v: formatNumber(usage?.promptTokens ?? 0), h: '上游回报的 prompt_tokens 合计' },
				{ k: '输出 token', v: formatNumber(usage?.completionTokens ?? 0), h: '上游回报的 completion_tokens 合计' },
			]

			return h(
				'div',
				{ className: 'credits-in', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
				h(
					'div',
					{ className: 'credits-card' },
					h(
						'div',
						{ className: 'credits-card-head' },
						h('h2', { className: 'credits-label' }, '使用看板'),
						h('span', { className: 'credits-aside' }, `近 ${days} 天 · ${accounts.length} 个账号有请求`),
					),
					h(
						'div',
						{ className: 'credits-stats' },
						stats.map(item =>
							h(
								'div',
								{ key: item.k, className: 'credits-stat', title: item.h },
								h('span', { className: 'credits-stat-k' }, item.k),
								h('span', { className: `credits-stat-v${item.tone ?? ''}` }, item.v),
								h('span', { className: 'credits-stat-h' }, item.h),
							),
						),
					),
				),
				h(
					'div',
					{ className: 'credits-card' },
					h(
						'div',
						{ className: 'credits-card-head' },
						h('h2', { className: 'credits-label' }, '按账号'),
						h('span', { className: 'credits-aside' }, '条长按请求数占比'),
					),
					h(
						'div',
						{ className: 'credits-usage' },
						accounts.map(account =>
							h(
								'div',
								{ key: account.accountId, className: 'credits-usage-row' },
								h(
									'div',
									{ className: 'credits-usage-head' },
									h(
										'span',
										{ className: 'credits-avatar', style: { background: gradientOf(account.accountId) }, 'aria-hidden': 'true' },
										initialOf({ id: account.accountId, label: labelOf(account.accountId) }),
									),
									h('span', { className: 'credits-usage-name', title: account.accountId }, labelOf(account.accountId)),
									h('span', { className: 'credits-aside' }, `${formatNumber(account.requests)} 次`),
									account.failed > 0 ? h(Badge, { tone: 'warn', title: '这些请求最终失败或被别的账号接管' }, `失败 ${formatNumber(account.failed)}`) : null,
								),
								h(
									'div',
									{ className: 'credits-usage-bar', role: 'img', 'aria-label': `${labelOf(account.accountId)} 的模型分布` },
									(account.models ?? []).map((model, index) =>
										h('span', {
											key: model.model,
											className: 'credits-usage-seg',
											style: { flexGrow: Math.max(1, model.requests), background: MODEL_COLORS[index % MODEL_COLORS.length] },
											title: `${shortModel(model.model)}：${formatNumber(model.requests)} 次${model.failed > 0 ? `，失败 ${formatNumber(model.failed)}` : ''}`,
										}),
									),
								),
								h(
									'div',
									{ className: 'credits-usage-models' },
									(account.models ?? []).map((model, index) =>
										h(
											'span',
											{ key: model.model, className: 'credits-model', title: `${model.model}：${formatNumber(model.requests)} 次` },
											h('i', { className: 'credits-model-dot', style: { background: MODEL_COLORS[index % MODEL_COLORS.length] } }),
											h('span', { className: 'credits-model-name' }, shortModel(model.model)),
											h('span', { className: 'credits-model-count' }, formatNumber(model.requests)),
										),
									),
								),
							),
						),
					),
				),
				Array.isArray(usage?.daily) && usage.daily.length > 1
					? h(
							'div',
							{ className: 'credits-card' },
							h(
								'div',
								{ className: 'credits-card-head' },
								h('h2', { className: 'credits-label' }, '按天'),
								h('span', { className: 'credits-aside' }, '请求数'),
							),
							h(
								'div',
								{ className: 'credits-daily' },
								usage.daily.map(day =>
									h(
										'div',
										{ key: day.day, className: 'credits-daily-col', title: `${day.day}：${formatNumber(day.requests)} 次` },
										h('span', { className: 'credits-daily-bar', style: { height: `${Math.max(4, Math.round((day.requests / Math.max(1, ...usage.daily.map(item => item.requests))) * 100))}%` } }),
										h('span', { className: 'credits-daily-k' }, String(day.day).slice(5)),
									),
								),
							),
						)
					: null,
			)
		}

		/* ================= 自动化 ================= */

		/** 自动签到开关、签到时刻、添加账号。 */
		function Automation(props) {
			const data = props.data
			const ready = data.busy || data.state === undefined
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 12 } },
				data.login === undefined
					? null
					: h(
							'div',
							{ className: 'credits-login' },
							h('span', null, '等待浏览器完成授权'),
							h('a', { href: data.login.authUrl, target: '_blank', rel: 'noopener noreferrer', title: data.login.authUrl }, data.login.authUrl),
							h(Btn, { kind: 'ghost', onClick: () => data.setLogin(undefined) }, '取消'),
						),
				h(
					'div',
					{ className: 'credits-card' },
					h('div', { className: 'credits-card-head' }, h('h2', { className: 'credits-label' }, '签到自动化')),
					h(
						'div',
						{ className: 'credits-field' },
						h(
							'div',
							{ className: 'credits-field-text' },
							h('span', { className: 'credits-field-name' }, '每日自动签到'),
							h('span', { className: 'credits-field-note' }, data.autoCheckin ? '到点自动把所有账号签一遍' : '关闭后只在手动点击时签到'),
						),
						h('button', {
							type: 'button',
							role: 'switch',
							className: 'credits-switch',
							'data-on': data.autoCheckin ? 'true' : 'false',
							'aria-checked': data.autoCheckin,
							disabled: ready,
							'aria-label': '每日自动签到',
							onClick: () => {
								const next = !data.autoCheckin
								data.setAutoCheckin(next)
								void data.actions.config({ autoCheckin: next })
							},
						}),
					),
					h(
						'div',
						{ className: 'credits-field' },
						h(
							'div',
							{ className: 'credits-field-text' },
							h('span', { className: 'credits-field-name' }, '签到时刻'),
							h('span', { className: 'credits-field-note' }, '按 UTC+8 的墙上时间，只在这一天还没签过时执行'),
						),
						h('input', {
							type: 'time',
							className: 'credits-time',
							value: data.timeText,
							disabled: ready,
							'aria-label': '签到时刻',
							onChange: event => data.setTimeText(event.target.value),
							onBlur: () => {
								const match = /^(\d{1,2}):(\d{2})$/.exec(data.timeText)
								if (match === null) return
								const minuteOfDay = Number(match[1]) * 60 + Number(match[2])
								if (minuteOfDay >= MINUTES_PER_DAY) return
								void data.actions.config({ minuteOfDay })
							},
						}),
					),
				),
				h(
					'div',
					{ className: 'credits-card' },
					h('div', { className: 'credits-card-head' }, h('h2', { className: 'credits-label' }, '账号')),
					h(
						'div',
						{ className: 'credits-field' },
						h(
							'div',
							{ className: 'credits-field-text' },
							h('span', { className: 'credits-field-name' }, '添加账号'),
							h('span', { className: 'credits-field-note' }, '点开后浏览器里走设备授权，凭据只落在本机 profile 目录'),
						),
						h(
							'span',
							{ className: 'credits-acc-actions' },
							h(Btn, { kind: 'primary', disabled: ready, onClick: () => data.actions.loginStart('cn') }, '添加国内账号'),
							h(Btn, { disabled: ready, onClick: () => data.actions.loginStart('global') }, '添加国际账号'),
						),
					),
				),
				modelPicker(data),
			)
		}

		/**
		 * 模型选择卡片：勾上的模型才会出现在宿主的模型选择器里。
		 *
		 * 清单是插件缓存在本地的上游清单（每天自动刷一次），因此这里同时给出
		 * 「上次刷新」与手动刷新入口；勾选写回服务端后宿主会重登记 provider，
		 * 模型选择器不用重启就变。
		 */
		function modelPicker(data) {
			const config = data.state?.config
			const catalog = Array.isArray(config?.catalog) ? config.catalog : []
			const shown = new Set(Array.isArray(config?.visibleModels) ? config.visibleModels : [])
			const ready = data.busy || data.state === undefined
			const toggle = id => {
				const next = catalog.filter(item => (item.id === id ? !shown.has(id) : shown.has(item.id))).map(item => item.id)
				if (next.length === 0) {
					// 全勾掉会让宿主的模型选择器空着，服务端也会拒；这里提前拦住。
					data.setNotice('至少留一个模型')
					return
				}
				void data.actions.visibleModels(next)
			}
			return h(
				'div',
				{ className: 'credits-card' },
				h(
					'div',
					{ className: 'credits-card-head' },
					h('h2', { className: 'credits-label' }, '模型选择'),
					h(
						'span',
						{ className: 'credits-acc-actions' },
						h('span', { className: 'credits-aside' }, config?.lastRefresh > 0 ? `清单更新于 ${clockText(config.lastRefresh)}` : '还没从上游取过清单'),
						h(Btn, { disabled: ready, onClick: () => void data.actions.refreshModels() }, '立即更新'),
					),
				),
				h(
					'div',
					{ className: 'credits-field', style: { alignItems: 'flex-start' } },
					h(
						'div',
						{ className: 'credits-field-text' },
						h('span', { className: 'credits-field-name' }, '出现在模型选择器的模型'),
						h(
							'span',
							{ className: 'credits-field-note' },
							catalog.length === 0
								? '还没有模型清单，点「立即更新」从上游取一次'
								: `共 ${catalog.length} 个，勾上 ${shown.size} 个；改动立刻生效，新上线模型默认可见`,
						),
					),
				),
				catalog.length === 0
					? null
					: h(
							'div',
							{ className: 'credits-models' },
							catalog.map(item =>
								h(
									'label',
									{ key: item.id, className: 'credits-model', 'data-on': shown.has(item.id) ? 'true' : 'false' },
									h('input', {
										type: 'checkbox',
										className: 'credits-model-in',
										checked: shown.has(item.id),
										disabled: ready,
										'aria-label': item.name,
										onChange: () => toggle(item.id),
									}),
									h('span', { className: 'credits-model-name' }, item.name),
									item.id === item.name ? null : h('span', { className: 'credits-model-id' }, item.id),
								),
							),
						),
			)
		}

		/* ================= 状态 ================= */

		function usePanelState() {
			const [state, setState] = react.useState(undefined)
			const [error, setError] = react.useState(undefined)
			const [busy, setBusy] = react.useState(false)
			const [notice, setNotice] = react.useState(undefined)
			const [login, setLogin] = react.useState(undefined)
			const [autoCheckin, setAutoCheckin] = react.useState(true)
			const [timeText, setTimeText] = react.useState(minuteText(600))

			const refresh = react.useCallback(async () => {
				try {
					const next = await loadSharedState()
					setState(next)
					setAutoCheckin(next.config.autoCheckin === true)
					setTimeText(minuteText(next.config.minuteOfDay))
					setError(undefined)
					return next
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure))
					return undefined
				}
			}, [])

			react.useEffect(() => {
				void refresh()
			}, [refresh])

			// 后台静默刷新：只换数据，不点亮 busy，所以不会打断正在做的操作。
			react.useEffect(() => {
				const timer = setInterval(() => void refresh(), AUTO_REFRESH_MS)
				return () => clearInterval(timer)
			}, [refresh])

			// 提示条自己退场：留着它反而挡住了下一次操作的结果。
			react.useEffect(() => {
				if (notice === undefined) return undefined
				const timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
				return () => clearTimeout(timer)
			}, [notice])

			const withBusy = react.useCallback(
				async fn => {
					setBusy(true)
					setNotice(undefined)
					try {
						await fn()
					} catch (failure) {
						setError(failure instanceof Error ? failure.message : String(failure))
					} finally {
						setBusy(false)
						await refresh()
					}
				},
				[refresh],
			)

			const key = state?.actionKey

			const actions = {
				checkin: id =>
					withBusy(async () => {
						const result = await act(key, { action: 'checkin', id })
						const row = result.result
						setNotice(
							row?.status === 'claimed'
								? `签到成功${typeof row.amount === 'number' ? ` +${row.amount}` : ''}`
								: row?.status === 'already-claimed'
									? '今天已经签过了'
									: row?.status === 'no-campaign'
										? '活动未开启'
										: (row?.message ?? '签到失败'),
						)
					}),
				checkinAll: () =>
					withBusy(async () => {
						const result = await act(key, { action: 'checkin' })
						const stats = result.stats ?? {}
						setNotice(`签到完成：成功 ${stats.claimed ?? 0}，已签 ${stats.already ?? 0}，失败 ${stats.failed ?? 0}`)
					}),
				rename: (row, label) =>
					withBusy(async () => {
						await act(key, { action: 'rename', id: row.id, label })
						setNotice('账号名已更新')
					}),
				remove: row =>
					withBusy(async () => {
						if (!window.confirm(`移除账号「${row.label ?? row.id}」？凭据会从本机删除。`)) return
						await act(key, { action: 'remove', id: row.id })
						setNotice('账号已移除')
					}),
				loginStart: region =>
					withBusy(async () => {
						const started = await act(key, { action: 'login-start', region })
						setLogin({ state: started.state, authUrl: started.authUrl, region: started.region, status: 'pending' })
						window.open(started.authUrl, '_blank', 'noopener')
					}),
				config: patch =>
					withBusy(async () => {
						await act(key, { action: 'config', ...patch })
						setNotice('设置已保存')
					}),
				/**
				 * 保存「哪些模型出现在模型选择器」。
				 *
				 * 宿主登记 provider 时就带上了模型清单，所以服务端存完会重登记一次；
				 * 这里只等回执，刷新由 withBusy 的收尾统一做。
				 */
				visibleModels: ids =>
					withBusy(async () => {
						const result = await act(key, { action: 'visible-models', visible: ids })
						setNotice(`模型选择器里现在有 ${result.visibleModels?.length ?? ids.length} 个模型`)
					}),
				refreshModels: () =>
					withBusy(async () => {
						const result = await act(key, { action: 'refresh-models' })
						setNotice(`已从上游拿到 ${result.models ?? 0} 个模型`)
					}),
				strategy: strategy =>
					withBusy(async () => {
						const result = await act(key, { action: 'strategy', strategy })
						setNotice(`账号调用已切到「${STRATEGY_OPTIONS.find(item => item.id === result.strategy)?.label ?? strategy}」`)
					}),
				/**
				 * 把某段对话固定到某个账号。固定写的是「用户的选择」，
				 * 不会因为闲置被自动换掉——和自动绑定是两张表。
				 */
				pin: (conversationId, accountId) =>
					withBusy(async () => {
						const result = await act(key, { action: 'pin', conversationId, id: accountId })
						setNotice(`这段对话已固定用「${result.pinned?.label ?? accountId}」`)
					}),
				unpin: conversationId =>
					withBusy(async () => {
						await act(key, { action: 'unpin', conversationId })
						setNotice('已解除固定，按当前调用方式重新分配')
					}),
			}

			react.useEffect(() => {
				if (login?.state === undefined || login.status !== 'pending') return undefined
				let alive = true
				const timer = setInterval(async () => {
					try {
						const polled = await act(key, { action: 'login-poll', state: login.state })
						if (!alive) return
						if (polled.status === 'complete') {
							setLogin(undefined)
							setNotice(`已添加账号 ${polled.account?.label ?? ''}`)
							await refresh()
						}
					} catch (failure) {
						if (!alive) return
						setLogin(undefined)
						setError(failure instanceof Error ? failure.message : String(failure))
					}
				}, STATE_POLL_MS)
				return () => {
					alive = false
					clearInterval(timer)
				}
			}, [login, key, refresh])

			return { state, error, busy, notice, login, setLogin, autoCheckin, setAutoCheckin, timeText, setTimeText, refresh, actions }
		}

		/* ================= 骨架屏 ================= */

		/** 首屏骨架：比「—」占位更像在干活，也避免卡片高度跳一下。 */
		function Skeleton(props) {
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 10 }, 'aria-busy': 'true', 'aria-label': '读取中' },
				props.compact === true ? null : h('div', { className: 'credits-skel', style: { height: 92 } }),
				h('div', { className: 'credits-skel', style: { height: 74 } }),
				h('div', { className: 'credits-skel', style: { height: 104 } }),
				h('div', { className: 'credits-skel', style: { height: 104 } }),
			)
		}

		/* ================= 面板 ================= */

		/**
		 * 面板本体。`variant` 决定外框：设置页里是窄卡片，中栏铺满可用宽度。
		 */
		function MultiCreditsPoolPanel(props) {
			const wide = props?.variant === 'panel'
			const data = usePanelState()
			const status = data.state?.status
			const totals = status?.totals
			const rows = status?.rows ?? []
			const rotation = data.state?.rotation
			const preview = Array.isArray(rotation?.preview) ? rotation.preview : []
			// `initialTab` 只给预览与断言用：静态渲染没有交互，没法点开第四页。
			const [tab, setTab] = react.useState(typeof props?.initialTab === 'string' ? props.initialTab : 'pool')
			// 同一时刻只展开一个账号：账号多时全部展开会把面板撑成几千像素。
			// `initialRename` 同样只给预览与断言用：静态渲染点不了按钮。
			const [expanded, setExpanded] = react.useState(typeof props?.initialRename === 'string' ? props.initialRename : undefined)
			// 改名就地编辑：桌面端窗口不支持 window.prompt，用它点按钮会静默什么都不发生。
			// 首帧状态文档还没回来，`draft` 留空，由渲染处退回账号名。
			const [renaming, setRenaming] = react.useState(
				typeof props?.initialRename === 'string' ? { id: props.initialRename, draft: rows.find(row => row.id === props.initialRename)?.label } : undefined,
			)
			const toggle = react.useCallback(id => {
				setRenaming(undefined)
				setExpanded(current => (current === id ? undefined : id))
			}, [])
			const startRename = row => setRenaming({ id: row.id, draft: row.label ?? '' })
			const cancelRename = () => setRenaming(undefined)
			const draftRename = text => setRenaming(current => (current === undefined ? current : { id: current.id, draft: text }))
			const submitRename = row => {
				if (renaming === undefined) return
				const label = renaming.draft.trim()
				// 空名在服务端会被拒；这里直接不提交，少一次往返。
				if (label === '') return
				setRenaming(undefined)
				void data.actions.rename(row, label)
			}

			const firstLoad = data.state === undefined && data.error === undefined
			const allSigned = totals !== undefined && totals.accounts > 0 && totals.checkedIn === totals.accounts

			const head = h(
				'div',
				{ className: 'credits-head' },
				h(
					'div',
					{ className: 'credits-id' },
					h('span', { className: 'credits-logo', 'aria-hidden': 'true' }, '◆'),
					h(
						'div',
						null,
						h('h1', { className: 'credits-name' }, PANEL_TITLE, h('span', { className: 'credits-ver' }, 'v2')),
						h(
							'p',
							{ className: 'credits-sub' },
							firstLoad
								? '读取账号状态…'
								: `${rows.length} 个账号 · 剩余 ${totals === undefined ? '—' : formatNumber(totals.creditsRemaining)} 积分 · ${allSigned ? '今天全部签完' : `${totals === undefined ? 0 : totals.accounts - totals.checkedIn} 个待签`}`,
						),
					),
				),
				h(
					'span',
					{ className: 'credits-head-actions' },
					h(
						'a',
						{
							className: 'credits-star',
							href: REPO_URL,
							target: '_blank',
							rel: 'noopener noreferrer',
							title: '在 GitHub 上打开这个项目，点亮 Star',
							'aria-label': 'GitHub 上点亮 Star',
						},
						h(
							'svg',
							{ width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
							h('path', { d: 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.4l6.5-.9z' }),
						),
						h('span', null, 'Star'),
					),
					h(Btn, { disabled: data.busy, spin: data.busy, onClick: () => void data.refresh(), title: '重新读取账号状态' }, data.busy ? '读取中' : '刷新'),
					h(Btn, { kind: 'primary', disabled: data.busy || rows.length === 0, onClick: () => data.actions.checkinAll() }, wide ? '全部签到' : '签到'),
					wide && props?.close !== undefined ? h(Btn, { kind: 'icon', onClick: () => props.close(), title: '关闭看板', label: '关闭看板' }, '✕') : null,
				),
			)

			const tabs = h(
				'div',
				{ className: 'credits-tabs', role: 'tablist' },
				TABS.map(item =>
					h(
						'button',
						{
							key: item.id,
							type: 'button',
							role: 'tab',
							className: 'credits-tab',
							'data-active': tab === item.id ? 'true' : 'false',
							'aria-selected': tab === item.id,
							onClick: () => setTab(item.id),
						},
						item.id === 'pool' && allSigned ? h('span', { className: 'credits-tab-dot', style: { color: 'var(--credits-ok)' } }) : null,
						item.label,
					),
				),
			)

			let body
			if (firstLoad) {
				body = h(Skeleton, { compact: !wide })
			} else if (tab === 'feed') {
				body = h(
					'div',
					{ className: 'credits-card credits-in' },
					h('div', { className: 'credits-card-head' }, h('h2', { className: 'credits-label' }, '签到动态'), h('span', { className: 'credits-aside' }, `最近 ${Math.min(RECENT_LIMIT, data.state?.recent?.length ?? 0)} 条`)),
					h(Feed, { entries: data.state?.recent }),
				)
			} else if (tab === 'auto') {
				body = h('div', { className: 'credits-in', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, h(Automation, { data }))
			} else if (tab === 'usage') {
				body = h(UsageBoard, { usage: data.state?.usage, rows })
			} else {
				body = h(
					'div',
					{ className: 'credits-in', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
					h(Stats, { totals, month: status?.month, generatedAt: data.state?.generatedAt }),
					h(StrategyCard, { data }),
					rows.length === 0
						? h(
								'div',
								{ className: 'credits-card' },
								h('div', { className: 'credits-card-head' }, h('h2', { className: 'credits-label' }, '账号')),
								h(
									'div',
									{ className: 'credits-empty' },
									h('span', { className: 'credits-empty-glyph' }, '＋'),
									h('span', null, '还没有账号。'),
									h('span', null, '到「自动化」里添加一个，走一次浏览器授权即可。'),
								),
							)
						: h(
								'div',
								{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
								h(
									'div',
									{ className: 'credits-card-head' },
									h('h2', { className: 'credits-label' }, '账号'),
									h('span', { className: 'credits-aside' }, `${rows.length} 个 · 点开看积分分段`),
								),
								h(
									'div',
									{ className: 'credits-accounts' },
									rows.map(row =>
										h(AccountRow, {
											key: row.id,
											row,
											rank: preview.indexOf(row.id),
											serving: preview[0] === row.id,
											busy: data.busy,
											expanded: expanded === row.id,
											renaming: renaming?.id === row.id,
											// 首帧状态文档还没回来，draft 是空的；这时候退回账号名，输入框不会先空一下。
											draft: renaming?.id === row.id ? (renaming.draft ?? row.label ?? '') : '',
											onToggle: toggle,
											onCheckin: data.actions.checkin,
											onRenameStart: startRename,
											onRenameDraft: draftRename,
											onRenameCancel: cancelRename,
											onRenameSubmit: submitRename,
											onRemove: data.actions.remove,
										}),
									),
								),
							),
				)
			}

			return h(
				'div',
				{ className: 'credits-page', 'data-variant': wide ? 'panel' : 'settings', 'data-busy': data.busy ? 'true' : 'false' },
				h(
					'div',
					{ className: 'credits-body' },
					h('div', { className: 'credits-sticky' }, head, tabs),
					data.error === undefined ? null : h(Toast, { kind: 'error' }, data.error),
					data.notice === undefined ? null : h(Toast, null, data.notice),
					body,
				),
			)
		}

		/**
		 * 侧边栏入口：一行显示剩余积分与今日已签数，点一下开看板。
		 *
		 * 数字跟着共享状态走：看板里签到、改名、刷新，这里立刻同步。看板关着时没有
		 * 别人拉状态，所以自己按间隔静默重拉，并在窗口重新获得焦点时补一次。
		 */
		function WorkBuddySidebarButton(props) {
			const [totals, setTotals] = react.useState(sharedState?.status?.totals)
			react.useEffect(() => {
				let alive = true
				const apply = next => {
					if (alive && next !== undefined) setTotals(next.status?.totals)
				}
				const unsubscribe = subscribeState(apply)
				void loadSharedState().then(apply).catch(() => {})
				const timer = setInterval(() => void loadSharedState().catch(() => {}), SIDEBAR_REFRESH_MS)
				const onFocus = () => void loadSharedState().catch(() => {})
				window.addEventListener('focus', onFocus)
				return () => {
					alive = false
					unsubscribe()
					clearInterval(timer)
					window.removeEventListener('focus', onFocus)
				}
			}, [])
			const allSigned = totals !== undefined && totals.accounts > 0 && totals.checkedIn === totals.accounts
			const dot = totals === undefined ? 'var(--credits-fg3)' : allSigned ? 'var(--credits-ok)' : 'var(--credits-warn)'
			return h(
				'button',
				{
					type: 'button',
					className: 'credits-side',
					onClick: () => props.open?.(),
					title: totals === undefined ? PANEL_TITLE : `${PANEL_TITLE}：剩余 ${formatNumber(totals.creditsRemaining)} 积分，今日 ${totals.checkedIn}/${totals.accounts} 已签`,
				},
				h('span', { className: 'credits-side-glyph', 'aria-hidden': 'true' }, '◆'),
				h(
					'span',
					{ className: 'credits-side-text' },
					h('span', { className: 'credits-side-main' }, totals === undefined ? PANEL_TITLE : `积分 ${formatNumber(totals.creditsRemaining)}`),
					h('span', { className: 'credits-side-sub' }, totals === undefined ? '读取中…' : `${totals.checkedIn}/${totals.accounts} 已签 · 点击打开`),
				),
				h('span', { className: 'credits-side-dot', style: { background: dot } }),
			)
		}

		/* ================= 对话头部：账号选择 ================= */

		/**
		 * 对话键前缀。插件注册的 provider 用 `cacheRetention: 'long'`，宿主因此把
		 * 会话 id 写进请求体的 `prompt_cache_key`；代理进程（`src/proxy.js` 的
		 * `conversationIdOf`）按 `字段名:值` 组成对话键。这里必须与它逐字一致，
		 * 否则固定写进去、请求时读不出来。
		 */
		const CONVERSATION_KEY_PREFIX = 'prompt_cache_key:'

		function conversationKeyOf(sessionId) {
			return typeof sessionId === 'string' && sessionId !== '' ? `${CONVERSATION_KEY_PREFIX}${sessionId}` : undefined
		}

		/**
		 * 对话标题栏右侧的账号按钮：显示这段对话当前用哪个账号，点开能改。
		 *
		 * 只在「对话固定」模式下有意义——别的模式下排序不看这段对话的绑定，
		 * 所以按钮退化成只读的当前出账账号，避免给出改不动的假选项。
		 */
		function ConversationAccountPicker(props) {
			const [state, setState] = react.useState(undefined)
			// `defaultOpen` 只给预览与断言用：静态渲染点不开菜单。
			const [open, setOpen] = react.useState(props?.defaultOpen === true)
			const [busy, setBusy] = react.useState(false)
			const [error, setError] = react.useState(undefined)
			const box = react.useRef(null)

			const refresh = react.useCallback(async () => {
				try {
					setState(await loadSharedState())
					setError(undefined)
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure))
				}
			}, [])

			react.useEffect(() => {
				void refresh()
			}, [refresh])

			// 展开时点空白处收起：浮层没有宿主提供的 portal，只能自己判边界。
			react.useEffect(() => {
				if (!open) return undefined
				const onDown = event => {
					const node = box.current
					if (node !== null && node !== undefined && typeof node.contains === 'function' && node.contains(event.target)) return
					setOpen(false)
				}
				const onKey = event => {
					if (event.key === 'Escape') setOpen(false)
				}
				document.addEventListener('mousedown', onDown)
				document.addEventListener('keydown', onKey)
				return () => {
					document.removeEventListener('mousedown', onDown)
					document.removeEventListener('keydown', onKey)
				}
			}, [open])

			const conversationId = conversationKeyOf(props?.sessionId)
			const rows = state?.status?.rows ?? []
			const pins = state?.pins ?? {}
			const strategy = state?.config?.strategy ?? 'sticky'
			const pinnedId = conversationId === undefined ? undefined : pins[conversationId]
			const pinnedRow = rows.find(row => row.id === pinnedId)
			const preview = Array.isArray(state?.rotation?.preview) ? state.rotation.preview : []
			const serving = rows.find(row => row.id === preview[0])
			const shown = pinnedRow ?? serving
			const sticky = strategy === 'sticky'

			const submit = async (action, payload) => {
				const key = state?.actionKey
				if (key === undefined) return
				setBusy(true)
				try {
					await act(key, { action, ...payload })
					await refresh()
					setOpen(false)
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure))
				} finally {
					setBusy(false)
				}
			}

			if (rows.length === 0) return null

			const title = pinnedRow === undefined
				? `这段对话下一个请求会走「${shown?.label ?? '未知账号'}」。点开可以固定到某个账号。`
				: `这段对话已固定用「${pinnedRow.label ?? pinnedRow.id}」。点开可以换或解除。`

			return h(
				'div',
				{ className: 'credits-pick', ref: box },
				h(
					'button',
					{
						type: 'button',
						className: 'credits-pick-btn',
						'data-pinned': pinnedRow === undefined ? 'false' : 'true',
						title,
						'aria-haspopup': 'listbox',
						'aria-expanded': open,
						onClick: () => setOpen(current => !current),
					},
					h('span', { className: 'credits-pick-dot', style: { background: pinnedRow === undefined ? 'var(--dsw-alias-label-tertiary,#9aa0a8)' : 'var(--dsw-alias-state-success-primary,#22a06b)' } }),
					h('span', { className: 'credits-pick-name' }, pinnedRow === undefined ? `跟随：${shown?.label ?? '—'}` : shown?.label ?? '—'),
					h('span', { className: 'credits-pick-caret', 'aria-hidden': 'true' }, '▾'),
				),
				open
					? h(
							'div',
							{ className: 'credits-pick-menu', role: 'listbox', 'aria-label': '这段对话用哪个账号' },
							h(
								'div',
								{ className: 'credits-pick-head' },
								sticky
									? '这段对话固定用哪个账号'
									: `当前是「${STRATEGY_OPTIONS.find(item => item.id === strategy)?.label ?? strategy}」，固定账号要先切回「对话固定」`,
							),
							rows.map(row =>
								h(
									'button',
									{
										key: row.id,
										type: 'button',
										role: 'option',
										className: 'credits-pick-item',
										'data-active': row.id === pinnedId ? 'true' : 'false',
										'aria-selected': row.id === pinnedId,
										disabled: busy || !sticky,
										title: `${row.label ?? row.id}：剩余 ${formatNumber(row.credits)} 积分${row.cooldownUntil === undefined ? '' : '，冷却中'}`,
										onClick: () => void submit('pin', { conversationId, id: row.id }),
									},
									h(
										'span',
										{ className: 'credits-pick-avatar', style: { background: gradientOf(row.id) }, 'aria-hidden': 'true' },
										initialOf(row),
									),
									h(
										'span',
										{ className: 'credits-pick-text' },
										h('span', { className: 'credits-pick-label' }, row.label ?? row.id),
										h(
											'span',
											{ className: 'credits-pick-sub' },
											`${formatNumber(row.credits)} 积分${row.cooldownUntil === undefined ? '' : ' · 冷却中'}${row.id === preview[0] ? ' · 下一个出账' : ''}`,
										),
									),
									row.id === pinnedId ? h('span', { className: 'credits-pick-check' }, '✓') : null,
								),
							),
							pinnedRow === undefined
								? null
								: h(
										'div',
										null,
										h('div', { className: 'credits-pick-sep' }),
										h(
											'button',
											{
												type: 'button',
												className: 'credits-pick-item',
												disabled: busy,
												title: '解除后按当前调用方式重新分配',
												onClick: () => void submit('unpin', { conversationId }),
											},
											h('span', { className: 'credits-pick-avatar', style: { background: 'transparent', color: 'inherit' }, 'aria-hidden': 'true' }, '↺'),
											h('span', { className: 'credits-pick-text' }, h('span', { className: 'credits-pick-label' }, '解除固定')),
										),
									),
							error === undefined
								? null
								: h('div', { className: 'credits-pick-head', style: { color: 'var(--dsw-alias-state-error-primary,#ef4444)' } }, error),
						)
					: null,
			)
		}

		/** 《插件设置》共享容器的外壳：只渲染子插槽。 */
		function PluginSettingsSection(props) {
			return h('ul', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 0, listStyle: 'none' } }, props.renderSlot(PLUGIN_SETTINGS_ITEM_SLOT, {}))
		}

		/**
		 * 当前选中的中栏面板 id，取不到就返回 undefined。
		 *
		 * 宿主暴露选中态的方式在不同版本里不一样（有的给 `currentPanel()`，有的把
		 * `panelInfo` 挂在 layout 上，可能是函数也可能是可读 store），所以三种都试一遍。
		 * 全都取不到时返回 undefined，调用方按「打开看板」处理。
		 */
		function panelIdOf(ctx) {
			const layout = ctx.get?.('layout')
			if (layout === undefined || layout === null) return undefined
			try {
				if (typeof layout.currentPanel === 'function') return layout.currentPanel()
			} catch {
				// 继续试别的读取方式
			}
			let value
			try {
				const info = layout.panelInfo
				value = typeof info === 'function' ? info() : typeof info?.get === 'function' ? info.get() : info
			} catch {
				return undefined
			}
			if (typeof value === 'string') return value
			if (value !== null && typeof value === 'object') return value.id ?? value.key ?? value.panelId
			return undefined
		}

		function selectPanel(ctx, id) {
			const layout = ctx.get?.('layout')
			if (typeof layout?.selectPanel !== 'function') return
			try {
				layout.selectPanel(id)
			} catch {
				// 目标 key 没注册时宿主会抛错且保持当前面板不动；再退一步回对话。
				try {
					layout.selectPanel(CONVERSATION_PANEL_ID)
				} catch (failure) {
					console.error('[multi-credits-pool] 切换中栏面板失败：', failure)
				}
			}
		}

		/** 侧边栏入口的动作：看板开着就收回对话，否则打开看板。 */
		function togglePanel(ctx) {
			const open = panelIdOf(ctx) === PANEL_ID
			selectPanel(ctx, open ? CONVERSATION_PANEL_ID : PANEL_ID)
		}

		function apply(ctx) {
			try {
				const registerItem = () =>
					ctx.slots.register({ name: PLUGIN_SETTINGS_ITEM_SLOT, id: PACKAGE_NAME, order: 40, inject: () => ({}) }, MultiCreditsPoolPanel)
				ctx.slots.inject('settings.section', () => {
					if (ctx.slots.entries('settings.section').some(entry => entry.options?.id === PLUGIN_SETTINGS_SECTION_ID)) return registerItem()
					try {
						return [
							ctx.slots.register(
								{
									name: 'settings.section',
									id: PLUGIN_SETTINGS_SECTION_ID,
									order: 900,
									label: () => '插件设置',
									children: { [PLUGIN_SETTINGS_ITEM_SLOT]: { kind: 'list', scope: 'root' } },
								},
								PluginSettingsSection,
							),
							registerItem(),
						]
					} catch {
						return registerItem()
					}
				})
			} catch (failure) {
				console.error('[multi-credits-pool] 设置卡片注册失败（模型通道不受影响）：', failure)
			}

			// 中栏看板：宿主声明了 main 插槽才注册，没声明时静默跳过。
			try {
				ctx.slots.inject('main', () =>
					ctx.slots.register(
						{
							name: 'main',
							key: PANEL_ID,
							inject: () => ({ variant: 'panel', close: () => selectPanel(ctx, CONVERSATION_PANEL_ID) }),
						},
						MultiCreditsPoolPanel,
					),
				)
			} catch (failure) {
				console.error('[multi-credits-pool] 看板注册失败（侧边栏入口与设置卡片不受影响）：', failure)
			}

			// 对话头部账号选择：只在宿主声明了这个插槽时注册，没声明就静默跳过。
			try {
				ctx.slots.inject(CONVERSATION_UTILITIES_SLOT, () =>
					ctx.slots.register({ name: CONVERSATION_UTILITIES_SLOT, id: CONVERSATION_PICKER_ID, order: 10, inject: () => ({}) }, ConversationAccountPicker),
				)
			} catch (failure) {
				console.error('[multi-credits-pool] 对话头部账号选择注册失败（其余入口不受影响）：', failure)
			}

			// 侧边栏入口：点开看板，已经打开时点一下收回对话。
			if (typeof ctx.inject === 'function') {
				try {
					ctx.inject(['layout'], layoutCtx => {
						const open = () => togglePanel(layoutCtx)
						try {
							layoutCtx.slots.inject('sidebar.footer.action', () =>
								layoutCtx.slots.register({ name: 'sidebar.footer.action', id: SIDEBAR_ID, order: 25, inject: () => ({ open }) }, WorkBuddySidebarButton),
							)
						} catch (failure) {
							console.error('[multi-credits-pool] 侧边栏入口注册失败：', failure)
						}
					})
				} catch (failure) {
					console.error('[multi-credits-pool] 侧边栏依赖注入失败：', failure)
				}
			}
		}

		exports.apply = apply
		exports.inject = inject
		exports.name = name
		return module.exports
	},
})
