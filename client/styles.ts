/**
 * Card stylesheet, taken verbatim from the Antigravity provider's client
 * (F:\\defws\\dsh-agy-provider\\client\\index.ts) with the `agy-` prefix renamed
 * to `zc-`. The user asked for this card to look exactly like that one, so the
 * look is a copy, not a design of ours: keep them in step when agy changes.
 *
 * Injected by the card as a single <style> node; every class is prefixed so it
 * cannot leak into the host's own settings UI.
 */
export const ZC_CSS = `
@keyframes zc-spin {
	0% { transform: rotate(0deg); }
	100% { transform: rotate(360deg); }
}

:root, body {
	--zc-font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif);
	--zc-bg-panel: var(--dsw-alias-bg-layer-2, #ffffff);
	--zc-bg-card: var(--dsw-alias-bg-layer-2, #ffffff);
	--zc-bg-card-primary: #f0f7ff;
	--zc-bg-header: var(--dsw-alias-bg-layer-1, #f8fafc);
	--zc-bg-box: var(--dsw-alias-bg-layer-1, #f8fafc);
	--zc-bg-subbox: var(--dsw-alias-bg-layer-3, #f1f5f9);
	--zc-bg-input: var(--dsw-alias-bg-layer-1, #ffffff);
	--zc-bg-btn: var(--dsw-alias-bg-layer-3, #f1f5f9);
	--zc-bg-btn-hover: var(--dsw-alias-interactive-bg-hover, #e2e8f0);
	--zc-bg-btn-primary: var(--dsw-alias-state-business-primary, #2563eb);
	--zc-bg-progress-track: #e2e8f0;

	--zc-border-card: var(--dsw-alias-border-l2, #e2e8f0);
	--zc-border-card-primary: #3b82f6;
	--zc-border-box: var(--dsw-alias-border-l1, #e2e8f0);
	--zc-border-subbox: var(--dsw-alias-border-l2, #cbd5e1);
	--zc-border-input: var(--dsw-alias-border-l2, #cbd5e1);
	--zc-border-input-focus: var(--dsw-alias-state-business-primary, #2563eb);
	--zc-border-btn: var(--dsw-alias-border-l2, #cbd5e1);
	--zc-border-btn-primary: #2563eb;
	--zc-border-divider: var(--dsw-alias-border-l2, #e2e8f0);

	--zc-text-primary: var(--dsw-alias-label-primary, #0f172a);
	--zc-text-secondary: var(--dsw-alias-label-secondary, #334155);
	--zc-text-tertiary: var(--dsw-alias-label-tertiary, #64748b);
	--zc-text-muted: var(--dsw-alias-label-caption, #94a3b8);
	--zc-text-btn: var(--dsw-alias-label-primary, #0f172a);
	--zc-text-btn-primary: #ffffff;
	--zc-text-window-label: #2563eb;

	--zc-shadow-card: 0 1px 3px rgba(0, 0, 0, 0.05);
	--zc-shadow-card-hover: 0 4px 12px rgba(0, 0, 0, 0.08);
	--zc-shadow-card-primary: 0 0 0 1px #3b82f6, 0 4px 14px rgba(37, 99, 235, 0.12);

	/* Badges */
	--zc-badge-primary-bg: #dbeafe;
	--zc-badge-primary-text: #1e40af;
	--zc-badge-primary-border: #60a5fa;

	--zc-badge-tag-bg: #f1f5f9;
	--zc-badge-tag-text: #334155;
	--zc-badge-tag-border: #cbd5e1;

	--zc-badge-email-bg: #eff6ff;
	--zc-badge-email-text: #1d4ed8;
	--zc-badge-email-border: #bfdbfe;

	--zc-badge-proxy-bg: #ecfdf5;
	--zc-badge-proxy-text: #047857;
	--zc-badge-proxy-border: #a7f3d0;

	--zc-badge-ready-bg: #ecfdf5;
	--zc-badge-ready-text: #047857;
	--zc-badge-ready-border: #a7f3d0;

	--zc-badge-unready-bg: #eff6ff;
	--zc-badge-unready-text: #1d4ed8;
	--zc-badge-unready-border: #bfdbfe;

	/* Quota status pills */
	--zc-quota-high-bg: #ecfdf5;
	--zc-quota-high-text: #047857;
	--zc-quota-high-border: #a7f3d0;
	--zc-quota-med-bg: #fffbeb;
	--zc-quota-med-text: #b45309;
	--zc-quota-med-border: #fde68a;
	--zc-quota-low-bg: #fef2f2;
	--zc-quota-low-text: #b91c1c;
	--zc-quota-low-border: #fecaca;
	--zc-quota-none-bg: #f1f5f9;
	--zc-quota-none-text: #64748b;
	--zc-quota-none-border: #cbd5e1;

	/* Danger button */
	--zc-danger-bg: #fef2f2;
	--zc-danger-text: #b91c1c;
	--zc-danger-border: #fecaca;
	--zc-danger-hover-bg: #fee2e2;

	/* Warning banner */
	--zc-warn-bg: #fffbeb;
	--zc-warn-text: #92400e;
	--zc-warn-border: #fcd34d;
	--zc-warn-btn-bg: #fef3c7;
	--zc-warn-btn-text: #92400e;
	--zc-warn-btn-border: #f59e0b;

	/* Toast notices */
	--zc-toast-success-bg: #ecfdf5;
	--zc-toast-success-text: #065f46;
	--zc-toast-success-border: #6ee7b7;
	--zc-toast-info-bg: #eff6ff;
	--zc-toast-info-text: #1e40af;
	--zc-toast-info-border: #93c5fd;
	--zc-toast-warn-bg: #fffbeb;
	--zc-toast-warn-text: #92400e;
	--zc-toast-warn-border: #fcd34d;
	--zc-toast-error-bg: #fef2f2;
	--zc-toast-error-text: #991b1b;
	--zc-toast-error-border: #fca5a5;

	/* Segment control */
	--zc-seg-group-bg: #e2e8f0;
	--zc-seg-group-border: #cbd5e1;
	--zc-seg-btn-text: #475569;
	--zc-seg-btn-active-bg: var(--dsw-alias-state-business-primary, #2563eb);
	--zc-seg-btn-active-text: #ffffff;
	--zc-seg-danger-bg: #dc2626;
	--zc-seg-danger-text: #ffffff;
	--zc-seg-danger-border: #b91c1c;
}

body[data-ds-dark-theme],
body.dark,
[data-theme="dark"] {
	--zc-bg-panel: var(--dsw-alias-bg-layer-2, #0f172a);
	--zc-bg-card: var(--dsw-alias-bg-layer-2, #1e293b);
	--zc-bg-card-primary: #111d33;
	--zc-bg-header: var(--dsw-alias-bg-layer-1, #1e293b);
	--zc-bg-box: var(--dsw-alias-bg-layer-1, #0f172a);
	--zc-bg-subbox: var(--dsw-alias-bg-layer-3, #090d16);
	--zc-bg-input: var(--dsw-alias-bg-layer-3, #090d16);
	--zc-bg-btn: var(--dsw-alias-bg-layer-3, #334155);
	--zc-bg-btn-hover: var(--dsw-alias-interactive-bg-hover, #475569);
	--zc-bg-btn-primary: var(--dsw-alias-state-business-primary, #2563eb);
	--zc-bg-progress-track: #1e293b;

	--zc-border-card: var(--dsw-alias-border-l2, #334155);
	--zc-border-card-primary: #3b82f6;
	--zc-border-box: var(--dsw-alias-border-l1, #1e293b);
	--zc-border-subbox: var(--dsw-alias-border-l2, #334155);
	--zc-border-input: var(--dsw-alias-border-l2, #334155);
	--zc-border-input-focus: #3b82f6;
	--zc-border-btn: var(--dsw-alias-border-l2, #475569);
	--zc-border-btn-primary: #3b82f6;
	--zc-border-divider: var(--dsw-alias-border-l2, #334155);

	--zc-text-primary: var(--dsw-alias-label-primary, #f8fafc);
	--zc-text-secondary: var(--dsw-alias-label-secondary, #cbd5e1);
	--zc-text-tertiary: var(--dsw-alias-label-tertiary, #94a3b8);
	--zc-text-muted: var(--dsw-alias-label-caption, #64748b);
	--zc-text-btn: var(--dsw-alias-label-primary, #ffffff);
	--zc-text-btn-primary: #ffffff;
	--zc-text-window-label: #93c5fd;

	--zc-shadow-card: 0 2px 8px rgba(0, 0, 0, 0.3);
	--zc-shadow-card-hover: 0 6px 16px rgba(0, 0, 0, 0.4);
	--zc-shadow-card-primary: 0 0 16px rgba(59, 130, 246, 0.25);

	/* Badges */
	--zc-badge-primary-bg: #1e3a8a;
	--zc-badge-primary-text: #93c5fd;
	--zc-badge-primary-border: #3b82f6;

	--zc-badge-tag-bg: #0f172a;
	--zc-badge-tag-text: #cbd5e1;
	--zc-badge-tag-border: #334155;

	--zc-badge-email-bg: #1e293b;
	--zc-badge-email-text: #93c5fd;
	--zc-badge-email-border: #3b82f6;

	--zc-badge-proxy-bg: #064e3b;
	--zc-badge-proxy-text: #6ee7b7;
	--zc-badge-proxy-border: #059669;

	--zc-badge-ready-bg: rgba(16, 185, 129, 0.15);
	--zc-badge-ready-text: #34d399;
	--zc-badge-ready-border: rgba(16, 185, 129, 0.35);

	--zc-badge-unready-bg: rgba(59, 130, 246, 0.15);
	--zc-badge-unready-text: #93c5fd;
	--zc-badge-unready-border: rgba(59, 130, 246, 0.35);

	/* Quota status pills */
	--zc-quota-high-bg: #064e3b;
	--zc-quota-high-text: #6ee7b7;
	--zc-quota-high-border: #059669;
	--zc-quota-med-bg: #451a03;
	--zc-quota-med-text: #fde68a;
	--zc-quota-med-border: #d97706;
	--zc-quota-low-bg: #450a0a;
	--zc-quota-low-text: #fca5a5;
	--zc-quota-low-border: #dc2626;
	--zc-quota-none-bg: #1e293b;
	--zc-quota-none-text: #94a3b8;
	--zc-quota-none-border: #475569;

	/* Danger button */
	--zc-danger-bg: #450a0a;
	--zc-danger-text: #fca5a5;
	--zc-danger-border: #ef4444;
	--zc-danger-hover-bg: #5f1313;

	/* Warning banner */
	--zc-warn-bg: #451a03;
	--zc-warn-text: #fde68a;
	--zc-warn-border: #d97706;
	--zc-warn-btn-bg: #78350f;
	--zc-warn-btn-text: #fde68a;
	--zc-warn-btn-border: #d97706;

	/* Toast notices */
	--zc-toast-success-bg: #064e3b;
	--zc-toast-success-text: #6ee7b7;
	--zc-toast-success-border: #059669;
	--zc-toast-info-bg: #1e3a8a;
	--zc-toast-info-text: #93c5fd;
	--zc-toast-info-border: #3b82f6;
	--zc-toast-warn-bg: #451a03;
	--zc-toast-warn-text: #fde68a;
	--zc-toast-warn-border: #d97706;
	--zc-toast-error-bg: #450a0a;
	--zc-toast-error-text: #fca5a5;
	--zc-toast-error-border: #dc2626;

	/* Segment control */
	--zc-seg-group-bg: #090d16;
	--zc-seg-group-border: #334155;
	--zc-seg-btn-text: #94a3b8;
	--zc-seg-btn-active-bg: var(--dsw-alias-state-business-primary, #2563eb);
	--zc-seg-btn-active-text: #ffffff;
	--zc-seg-danger-bg: #7f1d1d;
	--zc-seg-danger-text: #fca5a5;
	--zc-seg-danger-border: #ef4444;
}

.zc-spinner {
	display: inline-block;
	width: 12px;
	height: 12px;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	animation: zc-spin 0.75s linear infinite;
	vertical-align: -2px;
	margin-right: 5px;
}
.zc-pulse-dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
}
.zc-card-hover {
	transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
}
.zc-card-hover:hover {
	border-color: var(--zc-border-card-primary, #3b82f6) !important;
	box-shadow: var(--zc-shadow-card-hover) !important;
}
.zc-btn {
	transition: all 0.15s ease;
	user-select: none;
}
.zc-btn:hover:not(:disabled) {
	filter: brightness(1.08);
	transform: translateY(-0.5px);
}
.zc-btn:active:not(:disabled) {
	transform: translateY(0.5px);
}
.zc-progress-fill {
	transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.zc-submodel-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 7px 10px;
	font-size: 11.5px;
	border-radius: 6px;
	background: var(--zc-bg-subbox);
	border: 1px solid var(--zc-border-box);
	margin: 4px 0;
	color: var(--zc-text-primary);
}
.zc-select {
	appearance: none;
	-webkit-appearance: none;
	font: inherit;
	font-size: 11.5px;
	font-weight: 600;
	color: var(--zc-text-primary);
	background-color: var(--zc-bg-subbox);
	border: 1px solid var(--zc-border-box);
	border-radius: 6px;
	padding: 4px 20px 4px 8px;
	max-width: 190px;
	cursor: pointer;
	background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
	background-position: calc(100% - 11px) calc(50% + 1px), calc(100% - 7px) calc(50% + 1px);
	background-size: 4px 4px, 4px 4px;
	background-repeat: no-repeat;
}
.zc-select:hover:not(:disabled) {
	border-color: var(--zc-border-box);
	filter: brightness(1.05);
}
.zc-select:disabled {
	opacity: 0.55;
	cursor: default;
}
.zc-checklist {
	display: flex;
	flex-wrap: wrap;
	gap: 3px 14px;
	max-height: 112px;
	overflow-y: auto;
	padding: 6px 8px;
	border-radius: 6px;
	background: var(--zc-bg-subbox);
	border: 1px solid var(--zc-border-box);
}
.zc-check-item {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	font-size: 11.5px;
	color: var(--zc-text-primary);
	cursor: pointer;
	white-space: nowrap;
}
.zc-check-item input {
	cursor: pointer;
	margin: 0;
}
.zc-fold {
	border: 1px solid var(--zc-border-box);
	border-radius: 6px;
	background: var(--zc-bg-subbox);
}
.zc-fold > summary {
	cursor: pointer;
	list-style: none;
	user-select: none;
	font-weight: 600;
	font-size: 12px;
	opacity: 0.85;
	padding: 5px 9px;
	display: flex;
	align-items: center;
	gap: 6px;
}
.zc-fold > summary::-webkit-details-marker {
	display: none;
}
.zc-fold > summary::before {
	content: '▸';
	display: inline-block;
	font-size: 10px;
	transition: transform 0.15s ease;
}
.zc-fold[open] > summary::before {
	transform: rotate(90deg);
}
.zc-fold > summary:hover {
	opacity: 1;
}
.zc-fold-body {
	display: flex;
	flex-direction: column;
	gap: 3px;
	padding: 2px 9px 7px;
}
`

