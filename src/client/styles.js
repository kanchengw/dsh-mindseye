export const STYLE_ID = 'dsh-mindseye-settings'

export const CSS = `
.mindseye-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}
.mindseye-card:hover,.mindseye-card[data-open="true"]{border-color:var(--dsw-alias-label-dimmed)}
.mindseye-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2)}
.mindseye-header{width:100%;appearance:none;border:0;border-radius:12px;padding:14px 16px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px}
.mindseye-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mindseye-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.mindseye-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.mindseye-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.mindseye-pending{flex:none;border-radius:999px;padding:1px 8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.mindseye-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.mindseye-card[data-open="true"] .mindseye-chevron{transform:rotate(180deg)}
.mindseye-body{margin:0 16px;border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0 8px;display:grid;gap:14px}
.mindseye-section{display:grid;gap:10px}
.mindseye-section-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:1.5}
.mindseye-section-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.mindseye-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.mindseye-toggle input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.mindseye-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.mindseye-field{display:flex;flex-direction:column;gap:6px}
.mindseye-field span{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.mindseye-field small{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.mindseye-field input,.mindseye-field select{box-sizing:border-box;width:100%;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.mindseye-field input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.mindseye-field select[data-empty="true"]{color:var(--dsw-alias-label-tertiary)}
.mindseye-field select{padding:0 34px 0 12px}
.mindseye-field input:focus-visible,.mindseye-field select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.mindseye-field input:disabled,.mindseye-field select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.mindseye-password{position:relative;display:block}
.mindseye-password input{box-sizing:border-box;width:100%;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 36px 0 12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.mindseye-password input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.mindseye-password input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.mindseye-password-toggle{position:absolute;top:0;right:0;height:34px;width:36px;display:flex;align-items:center;justify-content:center;appearance:none;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.mindseye-password-toggle:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.mindseye-password-toggle:disabled{cursor:default}
.mindseye-error{color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5;margin:0}
.mindseye-override-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform)}
.mindseye-override-head span{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.mindseye-override-head button{appearance:none;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px}
.mindseye-override-head button:hover{color:var(--dsw-alias-label-error)}
.mindseye-override-body{border:1px solid var(--dsw-alias-border-l2);border-top:0;border-radius:0 0 8px 8px;padding:12px;display:grid;gap:12px;background:var(--dsw-alias-bg-layer-2)}
.mindseye-add-row{display:flex;gap:8px}
.mindseye-add-row select{flex:1;min-width:0;box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.mindseye-add-row button{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.mindseye-add-row button:disabled{opacity:.4;cursor:default}
.mindseye-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0 4px}
.mindseye-footer-status{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.mindseye-footer-status[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}
.mindseye-footer-status[data-tone="error"]{color:var(--dsw-alias-label-error)}
.mindseye-action{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.mindseye-action:disabled{opacity:.4;cursor:default}
.mindseye-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.mindseye-discard:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary)}
.mindseye-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.mindseye-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mindseye-generated-image-trigger{appearance:none;display:block;max-width:100%;border:0;border-radius:8px;padding:0;background:none;cursor:zoom-in}
.mindseye-generated-image-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mindseye-generated-image{display:block;max-width:100%;max-height:480px;border-radius:8px;object-fit:contain}
.mindseye-image-preview-dialog{width:auto;max-width:min(calc(100vw - 80px),1600px);max-height:calc(100vh - 80px);padding:0;gap:0;overflow:visible;border:0;border-radius:12px;background:var(--dsw-specific-input-major)}
.mindseye-image-preview{display:block;max-width:100%;max-height:calc(100vh - 80px);border-radius:12px;object-fit:contain}
.mindseye-image-preview-close{z-index:1;position:fixed;top:20px;right:20px;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:999px;padding:0;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);cursor:pointer}
.mindseye-image-preview-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media(max-width:640px){.mindseye-grid{grid-template-columns:1fr}.mindseye-footer{flex-wrap:wrap}.mindseye-footer-status{flex-basis:100%}.mindseye-image-preview-dialog{max-width:calc(100vw - 32px);max-height:calc(100vh - 64px)}.mindseye-image-preview{max-height:calc(100vh - 64px)}}
`
