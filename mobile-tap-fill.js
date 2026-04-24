/* ══════════════════════════════════════════════════════════════════
   MODO "TOCA Y RELLENA" PARA MÓVIL
   ──────────────────────────────────────────────────────────────────
   En pantallas pequeñas (≤768px), cuando el usuario está dentro del
   modal de Adquirir, la VISTA PREVIA del documento pasa a ser el
   protagonista. Cada placeholder amarillo se vuelve "tappeable":
   al tocarlo se abre una hoja inferior con un campo para escribir
   el valor; al guardar, el valor entra al documento en vivo.

   El módulo se apoya en las funciones y variables globales que ya
   existen en app.js (inicializarLivePreview, actualizarLivePreview,
   currentMinuta, camposLlenados, camposIALlenados, camposClausulas,
   eleccionesClausulas, minutaClausulas, placeholdersIA, currentStep,
   getStepPanelId, stepNext, renderCamposPage, camposCurrentPage,
   camposTotalPages). No reemplaza el flujo: lo complementa.
══════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const MQ_MOBILE = window.matchMedia("(max-width: 768px)");
  const isMobile  = () => MQ_MOBILE.matches;

  /* ───────────────────────────────────────────────────────────
     Helpers para descubrir a qué "tipo" pertenece un placeholder
     y qué label/hint mostrarle al usuario.
  ─────────────────────────────────────────────────────────── */
  function tipoPlaceholder(name, spanEl) {
    if (!name) return null;
    // 1) ¿Está dentro de una cláusula? Entonces puede ser camposExtra.
    if (spanEl) {
      const clEl = spanEl.closest && spanEl.closest(".lp-clause");
      if (clEl && Array.isArray(window.minutaClausulas)) {
        const idx = parseInt(clEl.dataset.clIdx || "-1", 10);
        const cl  = window.minutaClausulas[idx];
        if (cl && Array.isArray(cl.camposExtra) && cl.camposExtra.includes(name)) {
          return { kind: "clausula", clausulaId: cl.id, nombre: name, multiline: false, titulo: cl.titulo };
        }
      }
    }
    // 2) Campo de IA
    if (Array.isArray(window.placeholdersIA) && window.placeholdersIA.includes(name)) {
      return { kind: "ia", nombre: name, multiline: true };
    }
    // 3) Campo largo
    const cm = window.currentMinuta || {};
    if (Array.isArray(cm.camposLargo) && cm.camposLargo.includes(name)) {
      return { kind: "largo", nombre: name, multiline: true };
    }
    // 4) Campo normal
    if (Array.isArray(cm.campos) && cm.campos.includes(name)) {
      return { kind: "normal", nombre: name, multiline: false };
    }
    // Por defecto, lo tratamos como normal (texto corto)
    return { kind: "normal", nombre: name, multiline: false };
  }

  function obtenerValorActual(info) {
    if (!info) return "";
    switch (info.kind) {
      case "ia":
        return (window.camposIAMejorados && window.camposIAMejorados[info.nombre]) ||
               (window.camposIALlenados  && window.camposIALlenados[info.nombre])  || "";
      case "clausula": {
        const k = info.clausulaId + "_" + info.nombre;
        return (window.camposClausulas && window.camposClausulas[k]) || "";
      }
      case "largo":
      case "normal":
      default:
        return (window.camposLlenados && window.camposLlenados[info.nombre]) || "";
    }
  }

  function guardarValor(info, valor) {
    if (!info) return;
    const v = String(valor == null ? "" : valor);
    switch (info.kind) {
      case "ia":
        window.camposIALlenados = window.camposIALlenados || {};
        window.camposIALlenados[info.nombre] = v;
        // si el usuario edita, invalidamos la versión "mejorada por IA" previa
        if (window.camposIAMejorados && window.camposIAMejorados[info.nombre]) {
          delete window.camposIAMejorados[info.nombre];
        }
        break;
      case "clausula": {
        window.camposClausulas = window.camposClausulas || {};
        const k = info.clausulaId + "_" + info.nombre;
        window.camposClausulas[k] = v;
        // Si la cláusula no estaba marcada como incluida, marcarla
        if (window.eleccionesClausulas &&
            window.eleccionesClausulas[info.clausulaId] !== true) {
          window.eleccionesClausulas[info.clausulaId] = true;
        }
        break;
      }
      case "largo":
      case "normal":
      default:
        window.camposLlenados = window.camposLlenados || {};
        window.camposLlenados[info.nombre] = v;
        break;
    }

    // Espejar a cualquier input/textarea ya renderizado (si existe en el DOM)
    espejarAInputDOM(info, v);

    // Refrescar la vista previa
    if (typeof window.actualizarLivePreview === "function") {
      try { window.actualizarLivePreview(); } catch (_) {}
    }
    // Repintar progreso flotante
    actualizarProgresoMovil();
  }

  function espejarAInputDOM(info, v) {
    let selectores = [];
    if (info.kind === "normal" || info.kind === "largo") {
      selectores.push('.campo-input[data-campo="' + cssEsc(info.nombre) + '"]');
    } else if (info.kind === "ia") {
      selectores.push('.campo-ia-input[data-placeholder="' + cssEsc(info.nombre) + '"]');
    } else if (info.kind === "clausula") {
      selectores.push(
        '.clausula-campo-input[data-clausula="' + cssEsc(info.clausulaId) +
        '"][data-campo="' + cssEsc(info.nombre) + '"]'
      );
    }
    selectores.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(inp => {
          if (inp.value !== v) inp.value = v;
          inp.style.borderColor = "";
        });
      } catch (_) {}
    });
  }

  function cssEsc(s) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/(["\\])/g, "\\$1");
  }

  /* ───────────────────────────────────────────────────────────
     ¿En qué paso estamos? ¿Aplica el modo tap-to-fill?
  ─────────────────────────────────────────────────────────── */
  // Pasos donde la preview es relevante (afecta el progreso y el click delegado)
  function pasoUsaPreview() {
    if (typeof window.getStepPanelId !== "function") return false;
    let pid;
    try { pid = window.getStepPanelId(window.currentStep); } catch (_) { return false; }
    return pid === 2 || pid === "clausulas" || pid === 3;
  }
  // Pasos donde activamos el MODO TAP-FILL completo (preview a pantalla
  // completa + formulario oculto). En cláusulas NO, porque el usuario
  // necesita ver y tocar los botones "Incluir / Excluir cláusula".
  function pasoTapFillCompleto() {
    if (typeof window.getStepPanelId !== "function") return false;
    let pid;
    try { pid = window.getStepPanelId(window.currentStep); } catch (_) { return false; }
    return pid === 2 || pid === 3;
  }

  /* ───────────────────────────────────────────────────────────
     UI: hoja inferior (bottom sheet) para escribir el valor
  ─────────────────────────────────────────────────────────── */
  let sheetEl = null;
  let sheetInput = null;
  let sheetCtxInfo = null;

  function asegurarSheet() {
    if (sheetEl) return sheetEl;
    sheetEl = document.createElement("div");
    sheetEl.className = "tap-fill-sheet-overlay";
    sheetEl.innerHTML = `
      <div class="tap-fill-sheet" role="dialog" aria-modal="true" aria-labelledby="tap-fill-title">
        <div class="tap-fill-sheet-handle" aria-hidden="true"></div>
        <div class="tap-fill-sheet-header">
          <div>
            <div class="tap-fill-sheet-eyebrow" id="tap-fill-eyebrow">Campo</div>
            <h3 class="tap-fill-sheet-title" id="tap-fill-title">Campo</h3>
          </div>
          <button type="button" class="tap-fill-sheet-close" aria-label="Cerrar">×</button>
        </div>
        <div class="tap-fill-sheet-body">
          <div class="tap-fill-sheet-field" id="tap-fill-field"></div>
          <p class="tap-fill-sheet-hint" id="tap-fill-hint"></p>
        </div>
        <div class="tap-fill-sheet-footer">
          <button type="button" class="tap-fill-sheet-btn tap-fill-sheet-btn--ghost" data-action="cancelar">Cancelar</button>
          <button type="button" class="tap-fill-sheet-btn tap-fill-sheet-btn--primary" data-action="guardar">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(sheetEl);

    // Cerrar al tocar el fondo
    sheetEl.addEventListener("click", (e) => {
      if (e.target === sheetEl) cerrarSheet();
    });
    sheetEl.querySelector(".tap-fill-sheet-close").addEventListener("click", cerrarSheet);
    sheetEl.querySelector('[data-action="cancelar"]').addEventListener("click", cerrarSheet);
    sheetEl.querySelector('[data-action="guardar"]').addEventListener("click", guardarDesdeSheet);

    // Tecla Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sheetEl && sheetEl.classList.contains("open")) cerrarSheet();
    });
    return sheetEl;
  }

  function abrirSheet(info) {
    asegurarSheet();
    sheetCtxInfo = info;

    const eyebrow = sheetEl.querySelector("#tap-fill-eyebrow");
    const titulo  = sheetEl.querySelector("#tap-fill-title");
    const fieldEl = sheetEl.querySelector("#tap-fill-field");
    const hintEl  = sheetEl.querySelector("#tap-fill-hint");

    let kindLabel = "Campo";
    if (info.kind === "ia")        kindLabel = "Texto generado por IA";
    if (info.kind === "clausula")  kindLabel = "Cláusula: " + (info.titulo || "");
    if (info.kind === "largo")     kindLabel = "Texto largo";
    eyebrow.textContent = kindLabel;
    titulo.textContent = info.nombre;

    const valorPrev = obtenerValorActual(info);

    fieldEl.innerHTML = "";
    if (info.multiline) {
      const ta = document.createElement("textarea");
      ta.className = "tap-fill-sheet-input tap-fill-sheet-input--multiline";
      ta.rows = info.kind === "ia" ? 6 : 5;
      ta.placeholder = "Escribe aquí " + info.nombre.toLowerCase();
      ta.value = valorPrev;
      fieldEl.appendChild(ta);
      sheetInput = ta;
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "tap-fill-sheet-input";
      inp.placeholder = "Escribe " + info.nombre.toLowerCase();
      inp.value = valorPrev;
      // Heurística: si el nombre sugiere número/cédula/teléfono, usar teclado numérico
      const nm = info.nombre.toUpperCase();
      if (/CEDULA|CÉDULA|C\.C\.|NIT|TELEFONO|TELÉFONO|CELULAR|VALOR|PRECIO|MONTO|CANON|NUMERO|NÚMERO|CODIGO|CÓDIGO/.test(nm)) {
        inp.inputMode = "numeric";
      }
      fieldEl.appendChild(inp);
      sheetInput = inp;
    }

    if (info.kind === "ia") {
      hintEl.textContent = "Escribe con tus propias palabras. La IA pulirá la redacción al continuar.";
      hintEl.style.display = "";
    } else if (info.multiline) {
      hintEl.textContent = "Puedes pulsar Enter para hacer saltos de línea.";
      hintEl.style.display = "";
    } else {
      hintEl.textContent = "";
      hintEl.style.display = "none";
    }

    sheetEl.classList.add("open");
    document.body.classList.add("tap-fill-sheet-open");

    // Foco al input — pero después del transition para evitar saltos del teclado
    setTimeout(() => {
      try { sheetInput.focus({ preventScroll: true }); } catch (_) { try { sheetInput.focus(); } catch (__) {} }
      // En iOS, seleccionar el contenido facilita reemplazarlo
      if (sheetInput.select && sheetInput.value) { try { sheetInput.select(); } catch (_) {} }
    }, 250);

    // Enter en input simple = guardar (Shift+Enter en textarea = salto)
    sheetInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !info.multiline) {
        e.preventDefault();
        guardarDesdeSheet();
      }
    });
  }

  function cerrarSheet() {
    if (!sheetEl) return;
    sheetEl.classList.remove("open");
    document.body.classList.remove("tap-fill-sheet-open");
    sheetCtxInfo = null;
    sheetInput = null;
  }

  function guardarDesdeSheet() {
    if (!sheetCtxInfo || !sheetInput) { cerrarSheet(); return; }
    const v = (sheetInput.value || "").trim();
    if (!v) {
      // No permitir guardar vacío — sólo resaltar
      sheetInput.style.borderColor = "var(--danger)";
      sheetInput.focus();
      return;
    }
    const info = sheetCtxInfo;
    guardarValor(info, v);
    cerrarSheet();

    // Saltar al siguiente placeholder vacío automáticamente (UX rápido)
    setTimeout(() => avanzarASiguientePlaceholderVacio(info), 350);
  }

  /* ───────────────────────────────────────────────────────────
     Encontrar y enfocar el siguiente placeholder vacío
  ─────────────────────────────────────────────────────────── */
  function avanzarASiguientePlaceholderVacio(actualInfo) {
    const cont = document.getElementById("live-preview-content");
    if (!cont) return;
    const spans = Array.from(cont.querySelectorAll(".lp-ph"));
    if (!spans.length) return;
    // Encontrar el span actual (si todavía existe) para empezar a buscar después
    let startIdx = -1;
    if (actualInfo) {
      for (let i = 0; i < spans.length; i++) {
        if (spans[i].dataset.ph === actualInfo.nombre &&
            (actualInfo.kind !== "clausula" ||
             (spans[i].closest(".lp-clause") &&
              window.minutaClausulas &&
              window.minutaClausulas[parseInt(spans[i].closest(".lp-clause").dataset.clIdx || "-1", 10)] &&
              window.minutaClausulas[parseInt(spans[i].closest(".lp-clause").dataset.clIdx || "-1", 10)].id === actualInfo.clausulaId))) {
          startIdx = i;
          break;
        }
      }
    }
    // Buscar el primer span vacío después del actual (y luego desde el inicio si no hay)
    let next = null;
    for (let i = startIdx + 1; i < spans.length; i++) {
      if (esSpanVacio(spans[i])) { next = spans[i]; break; }
    }
    if (!next) {
      for (let i = 0; i < spans.length; i++) {
        if (esSpanVacio(spans[i])) { next = spans[i]; break; }
      }
    }
    if (next) {
      // Resaltar y hacer scroll
      cont.querySelectorAll(".lp-ph.lp-focus").forEach(s => s.classList.remove("lp-focus"));
      next.classList.add("lp-focus", "lp-pulse");
      setTimeout(() => next.classList.remove("lp-pulse"), 1400);
      const contRect = cont.getBoundingClientRect();
      const spanRect = next.getBoundingClientRect();
      const offset   = (spanRect.top - contRect.top) - (cont.clientHeight / 3);
      const target   = Math.max(0, cont.scrollTop + offset);
      cont.scrollTo({ top: target, behavior: "smooth" });
    } else {
      // Todo lleno → mensaje breve
      flashMensajeOK("¡Listo! Todos los campos completados.");
    }
  }

  function esSpanVacio(span) {
    if (!span) return false;
    if (span.classList.contains("filled")) return false;
    // Está vacío si su texto sigue siendo el nombre del placeholder
    return (span.textContent || "").trim().toUpperCase() ===
           String(span.dataset.ph || "").trim().toUpperCase();
  }

  /* ───────────────────────────────────────────────────────────
     Mensaje breve verde (toast simple, sin depender del de la app)
  ─────────────────────────────────────────────────────────── */
  let flashTimer = null;
  function flashMensajeOK(msg) {
    let el = document.getElementById("tap-fill-flash");
    if (!el) {
      el = document.createElement("div");
      el.id = "tap-fill-flash";
      el.className = "tap-fill-flash";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /* ───────────────────────────────────────────────────────────
     Progreso flotante: "X de Y campos"
  ─────────────────────────────────────────────────────────── */
  let chipEl = null;
  function asegurarChip() {
    if (chipEl) return chipEl;
    chipEl = document.createElement("div");
    chipEl.id = "tap-fill-progress";
    chipEl.className = "tap-fill-progress";
    chipEl.innerHTML = `
      <span class="tap-fill-progress-dot" aria-hidden="true"></span>
      <span class="tap-fill-progress-text">0 / 0</span>
    `;
    // Va dentro del modal-body para flotar sobre la preview
    const body = document.getElementById("modal-body");
    if (body) body.appendChild(chipEl);
    else document.body.appendChild(chipEl);
    return chipEl;
  }

  function calcularProgreso() {
    const cont = document.getElementById("live-preview-content");
    if (!cont) return { llenos: 0, total: 0 };
    const spans = cont.querySelectorAll(".lp-ph");
    let llenos = 0;
    spans.forEach(s => { if (s.classList.contains("filled")) llenos++; });
    return { llenos, total: spans.length };
  }

  function actualizarProgresoMovil() {
    if (!isMobile() || !pasoUsaPreview()) {
      if (chipEl) chipEl.classList.remove("visible");
      return;
    }
    asegurarChip();
    const { llenos, total } = calcularProgreso();
    const txt = chipEl.querySelector(".tap-fill-progress-text");
    if (txt) txt.textContent = llenos + " / " + total + " campos";
    chipEl.classList.toggle("visible", total > 0);
    chipEl.classList.toggle("complete", total > 0 && llenos === total);
  }

  /* ───────────────────────────────────────────────────────────
     Aplicar/quitar el modo tap-to-fill cuando cambia el paso
     o el tamaño de la pantalla.
  ─────────────────────────────────────────────────────────── */
  function aplicarModoMovil() {
    const body  = document.getElementById("modal-body");
    const modal = document.getElementById("modal-compra");
    if (!body || !modal) return;

    const debe = isMobile() && pasoTapFillCompleto() && body.classList.contains("with-live-preview");
    body.classList.toggle("tap-fill-mode", debe);
    if (debe) {
      // En tap-fill mode siempre la preview ocupa toda la pantalla
      body.classList.add("lp-mobile-open");
      // Ocultar el botón "Ver vista previa" (en tap-fill ya está abierta)
      const tgl = document.getElementById("live-preview-toggle-mobile");
      if (tgl) tgl.style.display = "none";
    } else {
      const tgl = document.getElementById("live-preview-toggle-mobile");
      if (tgl) tgl.style.display = "";
    }
    actualizarProgresoMovil();
  }

  // Observar cambios en las clases de #modal-body (livePreviewReady las cambia)
  function observarModalBody() {
    const body = document.getElementById("modal-body");
    if (!body) return;
    const obs = new MutationObserver(() => {
      aplicarModoMovil();
    });
    obs.observe(body, { attributes: true, attributeFilter: ["class"] });
  }

  // Observar cambios en el contenido de la vista previa para repintar el progreso
  function observarPreviewContent() {
    const cont = document.getElementById("live-preview-content");
    if (!cont) return;
    const obs = new MutationObserver(() => actualizarProgresoMovil());
    obs.observe(cont, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  }

  /* ───────────────────────────────────────────────────────────
     Click delegado: tocar un .lp-ph abre la hoja
  ─────────────────────────────────────────────────────────── */
  function instalarDelegacionClick() {
    document.addEventListener("click", (e) => {
      if (!isMobile()) return;
      const span = e.target && e.target.closest && e.target.closest(".lp-ph");
      if (!span) return;
      // Sólo si estamos en un paso que usa preview y el modal está abierto
      const overlay = document.getElementById("modal-overlay");
      if (!overlay || !overlay.classList.contains("open")) return;
      if (!pasoUsaPreview()) return;
      e.preventDefault();
      e.stopPropagation();
      const name = span.dataset.ph;
      const info = tipoPlaceholder(name, span);
      if (!info) return;
      abrirSheet(info);
    }, true); // capture=true para ganar a otros handlers
  }

  /* ───────────────────────────────────────────────────────────
     Hijack del botón "Continuar" en panel 2 y panel 3
     ──────────────────────────────────────────────────────────
     El validador original (validateCamposActuales / validateCamposIA)
     mira los inputs DOM de la página visible. En tap-fill no hay
     formulario visible: los datos viven en camposLlenados/IA. Para
     que el flujo existente funcione sin reescribirlo, hacemos:
       1) Saltar a la última página de campos y re-renderizarla
          (renderCamposPage rellena los inputs desde camposLlenados).
       2) Dejar que stepNext() valide y guarde como siempre.
     Para panel 3 IA: el modo "chat" valida contra el modelo
     directamente, así que con escribir en camposIALlenados es
     suficiente (lo hace nuestro guardarValor).
  ─────────────────────────────────────────────────────────── */
  function instalarHijackContinuar() {
    const btn = document.getElementById("btn-step-next");
    if (!btn) return;
    btn.addEventListener("click", function (ev) {
      if (!isMobile()) return;
      if (!pasoUsaPreview()) return;
      let pid;
      try { pid = window.getStepPanelId(window.currentStep); } catch (_) { return; }

      // Validar usando el modelo de datos (no el DOM): si falta algo,
      // bloquear el avance, mostrar mensaje y abrir el primero faltante.
      const faltante = primerFaltante(pid);
      if (faltante) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (typeof window.toast === "function") {
          window.toast("Te falta completar: " + faltante.nombre, "error");
        }
        avanzarASiguientePlaceholderVacio(null);
        return;
      }

      // Para panel 2: forzar el render de la última página antes de
      // que stepNext() llame a validateCamposActuales/saveCamposActuales.
      if (pid === 2 &&
          typeof window.renderCamposPage === "function" &&
          typeof window.camposTotalPages === "number" &&
          window.camposTotalPages > 0) {
        try {
          window.camposCurrentPage = window.camposTotalPages;
          window.renderCamposPage();
        } catch (_) {}
      }
      // Si estamos en cláusulas: el validador ya usa el modelo (camposClausulas
      // / eleccionesClausulas), así que no hay que tocar nada.
      // Si estamos en IA y existe el chat, el validador ya usa el modelo.
      // Dejamos que el handler original haga su trabajo a continuación.
    }, true); // capture=true para correr ANTES del handler original
  }

  function primerFaltante(pid) {
    if (pid === 2) {
      const cm = window.currentMinuta || {};
      const ll = window.camposLlenados || {};
      const lista = []
        .concat(cm.campos || [])
        .concat(cm.camposLargo || []);
      for (const n of lista) {
        if (!n) continue;
        if (!String(ll[n] || "").trim()) return { nombre: n };
      }
    } else if (pid === "clausulas") {
      const cls = window.minutaClausulas || [];
      const elec = window.eleccionesClausulas || {};
      const cc = window.camposClausulas || {};
      for (const cl of cls) {
        if (elec[cl.id] === undefined || elec[cl.id] === null) {
          return { nombre: 'cláusula "' + (cl.titulo || cl.id) + '"' };
        }
        if (elec[cl.id] === true && Array.isArray(cl.camposExtra)) {
          for (const campo of cl.camposExtra) {
            if (!String(cc[cl.id + "_" + campo] || "").trim()) {
              return { nombre: campo };
            }
          }
        }
      }
    } else if (pid === 3) {
      const ph = window.placeholdersIA || [];
      const ia = window.camposIALlenados || {};
      // Si todavía no se procesó la IA, exigimos textos crudos
      if (!window.iaYaProcesada) {
        for (const n of ph) {
          if (!String(ia[n] || "").trim()) return { nombre: n };
        }
      }
    }
    return null;
  }

  /* ───────────────────────────────────────────────────────────
     Inicialización: arrancar cuando el DOM esté listo y el
     modal-body exista. No depende de Firebase ni de mammoth.
  ─────────────────────────────────────────────────────────── */
  function init() {
    observarModalBody();
    observarPreviewContent();
    instalarDelegacionClick();
    instalarHijackContinuar();
    aplicarModoMovil();
    actualizarProgresoMovil();

    MQ_MOBILE.addEventListener
      ? MQ_MOBILE.addEventListener("change", aplicarModoMovil)
      : MQ_MOBILE.addListener && MQ_MOBILE.addListener(aplicarModoMovil);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
