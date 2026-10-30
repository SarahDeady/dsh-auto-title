/**
 * Client half of `dsh-auto-title` (自动会话标题 / Auto Session Title).
 *
 * 在侧栏会话的「⋯」菜单里加一行「刷新标题」，点它就让 Host 立刻重新提炼标题。
 * Adds one row to a Session's "..." menu (beside 置顶 / 重命名 / 分叉 / 归档 /
 * 复制 Session ID). The Host then re-distills the title:
 *   POST /auto-title/refresh?sessionId=<id>
 * Host 侧调用 `ctx.sessionTitle.refresh(session)`，追加 source=provider 的
 * `session/title` 事件；内置的 `title` session projection 会把它送到 UI，因此
 * 侧栏行和页头标题都会自己更新，客户端无需推送任何东西。
 * The Host calls `ctx.sessionTitle.refresh(session)`, which appends a
 * source=provider `session/title` event; the shipped `title` session projection
 * carries it to the UI, so the sidebar row and the header update themselves.
 *
 * 菜单的关闭方式与内置行一致：slot 注入 `useMenuOpenState`（hook 工厂），
 * 其返回元组的第二项即关闭菜单的 setter。
 * The row dismisses the menu the way the shipped rows do: the slot injects
 * `useMenuOpenState` (a hook factory) whose tuple's second element closes it.
 */
window.__ModuleLoader__.load({
	id: 'dsh-auto-title',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const NS = 'auto-title';
		const ROUTE = '/auto-title/refresh';

		const DICTS = {
			zh: {
				'menu.refresh': '刷新标题',
				'menu.busy': '正在提炼标题…',
				'menu.failed': '刷新失败，点击重试',
			},
			en: {
				'menu.refresh': 'Refresh title',
				'menu.busy': 'Refining title…',
				'menu.failed': 'Refresh failed — click to retry',
			},
		};

		const CSS = `
.auto-title-menu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;white-space:nowrap;}
.auto-title-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12)));}
.auto-title-menu-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px;}
.auto-title-menu-item:disabled{cursor:default;opacity:.65;}
.auto-title-menu-item[data-failed='true']{color:var(--dsw-alias-state-error-primary,#d92d20);}
.auto-title-menu-item > i{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;}
.auto-title-menu-item[data-busy='true'] > i{animation:auto-title-spin .9s linear infinite;}
.auto-title-menu-item > span{min-width:0;overflow:hidden;text-overflow:ellipsis;}
@keyframes auto-title-spin{to{transform:rotate(-360deg);}}
`;

		/** 占位 hook，保证 owner 不再注入时 hook 顺序不变 / keeps the hook order stable. */
		function useNoopMenuState() {
			return React.useState(false);
		}

		/**
		 * 读取 slot 注入的菜单开关状态，返回关闭菜单的 setter。
		 * Read the slot-injected menu-open state and return the dismiss setter.
		 * @param useMenuOpenState - slot 注入的 hook 工厂 / injected hook factory.
		 * @returns 关闭菜单的函数，拿不到时为 undefined / the setter, or undefined.
		 */
		function useMenuCloser(useMenuOpenState) {
			const hook = typeof useMenuOpenState === 'function' ? useMenuOpenState : useNoopMenuState;
			const tuple = hook();
			return Array.isArray(tuple) ? tuple[1] : undefined;
		}

		/** 逆时针刷新箭头，16px，跟着 currentColor / counter-clockwise refresh arrow. */
		function RefreshIcon() {
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: 16,
					height: 16,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('path', { d: 'M2.6 8a5.4 5.4 0 1 0 1.7-3.9' }),
				h('path', { d: 'M2.2 2.2v3h3' }),
			);
		}

		/**
		 * 会话菜单的一行：强制为这个会话重新提炼标题。
		 * One Session menu row: request a fresh model-distilled title.
		 * @param props - 行 owner 给的 sessionId/displayTitle、注入的菜单状态 hook、
		 *                以及 `auto-title` 的 locale 座位 / row owner props + injected hook + locale seat.
		 * @returns 菜单行 / the menu row.
		 */
		function RefreshTitleMenuItem(props) {
			const sessionId = props.sessionId;
			const t = props.t;
			const setMenuOpen = useMenuCloser(props.useMenuOpenState);
			const [busy, setBusy] = React.useState(false);
			const [failure, setFailure] = React.useState(null);

			const run = React.useCallback(() => {
				if (busy) return;
				if (sessionId === undefined || sessionId === null || sessionId === '') {
					setFailure('no-session');
					return;
				}
				setBusy(true);
				setFailure(null);
				// 用 GET：Harness Web 的鉴权层会先拦下未认证的 POST（405），
				// 而 GET 会照常进入路由表，插件路由因此不会被挡。
				// GET: the Web auth layer answers unauthenticated POST with 405
				// before routing, while GET reaches the route table.
				fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
					method: 'GET',
					credentials: 'same-origin',
					headers: { accept: 'application/json' },
					cache: 'no-store',
				})
					.then(async (response) => {
						const payload = await response.json().catch(() => null);
						if (payload === null || payload.ok !== true) {
							const reason =
								payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
							setFailure(reason);
							return;
						}
						if (typeof setMenuOpen === 'function') setMenuOpen(false);
					})
					.catch((reason) => {
						setFailure(reason instanceof Error ? reason.message : String(reason));
					})
					.finally(() => {
						setBusy(false);
					});
			}, [busy, sessionId, setMenuOpen]);

			const label = busy ? t('menu.busy') : failure === null ? t('menu.refresh') : t('menu.failed');

			return h(
				'button',
				{
					type: 'button',
					role: 'menuitem',
					className: 'auto-title-menu-item',
					'data-busy': busy ? 'true' : 'false',
					'data-failed': failure === null ? 'false' : 'true',
					disabled: busy,
					title: failure === null ? undefined : `auto-title: ${failure}`,
					onClick: run,
				},
				h('i', null, h(RefreshIcon)),
				h('span', null, label),
			);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, { zh: DICTS.zh, en: DICTS.en }), 'auto-title: dictionaries');

				ctx.effect(() => {
					const tag = document.createElement('style');
					tag.dataset.autoTitle = 'menu';
					tag.textContent = CSS;
					document.head.appendChild(tag);
					return () => {
						tag.remove();
					};
				}, 'auto-title: menu styles');

				const t = ctx.locale.bind(NS);
				ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
					ctx.slots.register(
						{
							name: 'sidebar.workspaces.session.menu.item',
							id: 'auto-title:refresh',
							order: 250,
							locale: NS,
							label: () => t('menu.refresh'),
						},
						RefreshTitleMenuItem,
					),
				);
			},
		};
	},
});
