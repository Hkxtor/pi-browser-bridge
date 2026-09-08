(function(){if(globalThis.__piBrowserVisualIndicator)return;let o=null,r=null,i=null,a=!1,c=!1,m=!1,l=null;function w(){if(l)return l;let e=document.getElementById("pibrowser-shadow-container");return e&&e.shadowRoot?(l=e.shadowRoot,l):(e=document.createElement("div"),e.id="pibrowser-shadow-container",e.style.cssText="all: initial; position: fixed; z-index: 2147483647;",l=e.attachShadow({mode:"open"}),document.body.appendChild(e),l)}function b(e){const n=globalThis.__piBrowserAccessibilityTree;if(!n){console.warn("[PiBrowserBridge] Accessibility tree not available");return}const t=n.getElementByRef(e);if(!t){console.warn("[PiBrowserBridge] Element not found:",e);return}d();const s=t.getBoundingClientRect(),g=window.scrollX||window.pageXOffset,y=window.scrollY||window.pageYOffset,v=w(),h=document.createElement("div");h.id="pibrowser-highlight-overlay",h.style.cssText=`
      position: absolute;
      left: ${s.left+g-5}px;
      top: ${s.top+y-5}px;
      width: ${s.width+10}px;
      height: ${s.height+10}px;
      border: 3px solid #4CAF50;
      border-radius: 4px;
      pointer-events: none;
      animation: pibrowser-pulse 1s ease-in-out infinite;
      box-sizing: border-box;
    `;const T=document.createElement("style");T.textContent=`
      @keyframes pibrowser-pulse {
        0%, 100% {
          border-color: #4CAF50;
          box-shadow: 0 0 5px rgba(76, 175, 80, 0.5);
        }
        50% {
          border-color: #81C784;
          box-shadow: 0 0 20px rgba(76, 175, 80, 0.8);
        }
      }
    `,v.appendChild(T),v.appendChild(h),t.scrollIntoView({behavior:"smooth",block:"center",inline:"nearest"})}function d(){const e=document.getElementById("pibrowser-shadow-container");if(e&&e.shadowRoot){const n=e.shadowRoot.getElementById("pibrowser-highlight-overlay");n&&n.remove()}}function x(e="loading"){const n=w(),t=n.getElementById("pibrowser-status-badge");t&&t.remove();const s=document.createElement("div");s.id="pibrowser-status-badge";const g={loading:"⏳",completed:"✅",error:"❌"},y={loading:"#2196F3",completed:"#4CAF50",error:"#f44336"};s.style.cssText=`
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${y[e]};
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.3s ease;
      z-index: 2147483647;
    `,s.innerHTML=`${g[e]} ${e.charAt(0).toUpperCase()+e.slice(1)}`,s.onclick=()=>{s.style.opacity="0",setTimeout(()=>s.remove(),300)},n.appendChild(s),r=s}function p(){r&&(r.remove(),r=null)}function f(){a=!0;const e=w();if(!e.getElementById("pibrowser-pulse-styles")){const n=document.createElement("style");n.id="pibrowser-pulse-styles",n.textContent=`
        @keyframes pibrowser-agent-pulse {
          0%, 100% {
            box-shadow: 
              inset 0 0 4px rgba(74, 222, 128, 0.5),
              inset 0 0 8px rgba(74, 222, 128, 0.25);
          }
          50% {
            box-shadow: 
              inset 0 0 6px rgba(74, 222, 128, 0.7),
              inset 0 0 12px rgba(74, 222, 128, 0.35);
          }
        }
      `,e.appendChild(n)}i?i.style.display="":(i=document.createElement("div"),i.id="pibrowser-agent-glow-border",i.style.cssText=`
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 2147483646;
        opacity: 0;
        transition: opacity 0.3s ease-in-out;
        animation: pibrowser-agent-pulse 2s ease-in-out infinite;
        box-shadow: 
          inset 0 0 4px rgba(74, 222, 128, 0.5),
          inset 0 0 8px rgba(74, 222, 128, 0.25);
      `,e.appendChild(i)),o||(o=E(),e.appendChild(o)),requestAnimationFrame(()=>{i.style.opacity="1",o&&(o.style.opacity="1",o.style.transform="translate(-50%, 0)")})}function E(e){const n=document.createElement("div");n.id="pibrowser-agent-stop-container",n.style.cssText=`
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      pointer-events: none;
      z-index: 2147483647;
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    `;const t=document.createElement("button");return t.id="pibrowser-agent-stop-button",t.innerHTML=`
      <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" style="display:inline-block;vertical-align:middle;margin-right:8px;">
        <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>
      </svg>
      <span style="vertical-align:middle">Stop Action</span>
    `,t.style.cssText=`
      position: relative;
      padding: 12px 16px;
      background: #FAF9F5;
      color: #141413;
      border: 0.5px solid rgba(31, 30, 29, 0.4);
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 
        0 40px 80px rgba(74, 222, 128, 0.24),
        0 4px 14px rgba(74, 222, 128, 0.24);
      transition: all 0.2s ease;
      pointer-events: auto;
    `,t.addEventListener("mouseenter",()=>{a&&(t.style.background="#F5F4F0")}),t.addEventListener("mouseleave",()=>{a&&(t.style.background="#FAF9F5")}),t.addEventListener("click",async()=>{try{await chrome.runtime.sendMessage({type:"STOP_TOOL_EXECUTION"}),t.textContent="Stopping...",t.disabled=!0,t.style.opacity="0.7",setTimeout(()=>{k()},500)}catch(s){console.error("[PiBrowserBridge] Failed to send stop message:",s)}}),n.appendChild(t),n}function u(){a=!1,i&&(i.style.opacity="0",setTimeout(()=>{i&&!a&&(i.style.display="none")},300)),o&&(o.style.opacity="0",o.style.transform="translate(-50%, 100px)",setTimeout(()=>{o&&!a&&(o.remove(),o=null)},300))}function k(){c=a,i&&(i.style.display="none"),o&&(o.style.display="none"),r&&(r.style.display="none")}function S(){c&&(i&&(i.style.display="",requestAnimationFrame(()=>{i.style.opacity="1"})),o&&(o.style.display="",requestAnimationFrame(()=>{o.style.opacity="1",o.style.transform="translate(-50%, 0)"}))),c=!1}chrome.runtime.onMessage.addListener((e,n,t)=>{switch(e.type){case"SHOW_HIGHLIGHT":b(e.ref),t({success:!0});break;case"HIDE_HIGHLIGHT":d(),t({success:!0});break;case"SHOW_STATUS":x(e.status),t({success:!0});break;case"HIDE_STATUS":p(),t({success:!0});break;case"SHOW_STOP":f(),t({success:!0});break;case"HIDE_STOP":u(),t({success:!0});break;case"SHOW_PULSING_BORDER":m=e.isMcp||!1,f(),t({success:!0});break;case"HIDE_ALL_INDICATORS":u(),p(),t({success:!0});break;case"HIDE_FOR_TOOL_USE":c=a,k(),t({success:!0});break;case"SHOW_AFTER_TOOL_USE":S(),t({success:!0});break;default:t({success:!1,error:`Unknown message type: ${e.type}`})}return!0}),globalThis.__piBrowserVisualIndicator={highlightElement:b,clearHighlight:d,showStatusBadge:x,hideStatusBadge:p,showPulsingBorder:f,hidePulsingBorder:u,get state(){return{isPulsingActive:a,isMcp:m,wasPulsingBeforeHide:c}}},window.addEventListener("beforeunload",()=>{u(),p(),d()}),typeof window<"u"&&window.location.hostname==="localhost"&&console.log("[PiBrowserBridge] Visual indicator injected with state management")})();
