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
     EDICIÓN EN LÍNEA dentro del propio placeholder
     ──────────────────────────────────────────────────────────
     El usuario toca el cuadro amarillo y escribe ahí mismo,
     sobre el documento. Sin ventanas flotantes ni formularios.
  ─────────────────────────────────────────────────────────── */

  // Si el nombre sugiere un valor numérico, sugerimos teclado numérico
  function esCampoNumerico(nombre) {
    const nm = String(nombre || "").toUpperCase();
    return /CEDULA|CÉDULA|C\.C\.|NIT|TELEFONO|TELÉFONO|CELULAR|VALOR|PRECIO|MONTO|CANON|N[ÚU]MERO|C[ÓO]DIGO/.test(nm);
  }

  function editarInline(span, info) {
    if (!span || !info) return;
    if (span.classList.contains("lp-ph-editing")) {
      // Ya está editando — sólo asegurar el foco
      try { span.focus(); } catch (_) {}
      return;
    }

    // Cancelar cualquier otra edición abierta primero
    document.querySelectorAll(".lp-ph.lp-ph-editing").forEach((el) => {
      if (el !== span) finalizarEdicion(el, true);
    });

    // Guardar el estado previo del span para poder restaurarlo si se cancela
    const valorPrev = (span.classList.contains("filled") && (span.textContent || "").trim())
      ? span.textContent.trim()
      : obtenerValorActual(info);

    span._tapFillBackup = {
      text: span.textContent,
      filled: span.classList.contains("filled"),
      info: info,
    };

    span.contentEditable = "true";
    span.spellcheck = false;
    span.setAttribute("autocapitalize", info.kind === "normal" ? "words" : "sentences");
    span.setAttribute("autocorrect", "off");
    span.setAttribute("inputmode", esCampoNumerico(info.nombre) ? "numeric" : "text");
    span.classList.add("lp-ph-editing");

    // Mostrar el valor existente (si lo hay) o vacío para empezar a escribir
    span.textContent = valorPrev || "";

    // CRÍTICO: focus() debe llamarse SINCRÓNICAMENTE, dentro del mismo
    // gesto del usuario que disparó el click. iOS Safari (y muchos
    // navegadores móviles) sólo abren el teclado virtual cuando el foco
    // ocurre dentro del manejador del touch/click. Si lo metemos en un
    // setTimeout, queda fuera del gesto y el teclado NO aparece.
    try { span.focus({ preventScroll: false }); } catch (_) { try { span.focus(); } catch (__) {} }

    // La selección del texto y el scroll sí pueden esperar al siguiente
    // tick — no requieren gesto del usuario.
    setTimeout(() => {
      // Seleccionar todo el contenido — un toque y reemplaza
      try {
        const range = document.createRange();
        range.selectNodeContents(span);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {}
      // Asegurar que el span esté visible (no tapado por el teclado)
      try {
        span.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (_) {}
    }, 60);

    const onKey = (e) => {
      if (e.key === "Enter") {
        // Enter (sin Shift) = guardar y avanzar
        if (!e.shiftKey) {
          e.preventDefault();
          finalizarEdicion(span, true, /*avanzar*/ true);
        }
        // Shift+Enter = permitir salto de línea (útil en textos largos / IA)
      } else if (e.key === "Escape") {
        e.preventDefault();
        finalizarEdicion(span, false);
      } else if (e.key === "Tab") {
        e.preventDefault();
        finalizarEdicion(span, true, /*avanzar*/ true);
      }
    };
    const onBlur = () => {
      // Pequeño retardo: si el blur es por tocar otro placeholder, dejamos
      // que el click de ese otro placeholder se procese antes
      setTimeout(() => {
        if (span.classList.contains("lp-ph-editing")) {
          finalizarEdicion(span, true, /*avanzar*/ false);
        }
      }, 80);
    };
    // Evitar que un click DENTRO del span ya en edición burbujee al
    // delegado y reabra la edición
    const onClickStop = (e) => {
      if (span.classList.contains("lp-ph-editing")) {
        e.stopPropagation();
      }
    };

    span._tapFillHandlers = { onKey, onBlur, onClickStop };
    span.addEventListener("keydown", onKey);
    span.addEventListener("blur", onBlur);
    span.addEventListener("click", onClickStop);
  }

  function finalizarEdicion(span, guardar, avanzar) {
    if (!span || !span.classList.contains("lp-ph-editing")) return;
    const backup = span._tapFillBackup || {};
    const handlers = span._tapFillHandlers || {};
    if (handlers.onKey)       span.removeEventListener("keydown", handlers.onKey);
    if (handlers.onBlur)      span.removeEventListener("blur", handlers.onBlur);
    if (handlers.onClickStop) span.removeEventListener("click", handlers.onClickStop);

    span.contentEditable = "false";
    span.removeAttribute("inputmode");
    span.removeAttribute("autocapitalize");
    span.removeAttribute("autocorrect");
    span.classList.remove("lp-ph-editing");

    const info = backup.info;
    if (guardar && info) {
      const v = (span.textContent || "").trim();
      if (v) {
        // guardarValor() también llama a actualizarLivePreview(), que
        // re-renderiza este span (innerHTML = valor) — visualmente queda
        // igual, pero ahora con la clase .filled y el ✓.
        guardarValor(info, v);
        if (avanzar) {
          setTimeout(() => avanzarASiguientePlaceholderVacio(info), 220);
        }
      } else {
        // Vacío: restaurar el nombre original del placeholder
        span.textContent = info.nombre;
        span.classList.remove("filled");
      }
    } else {
      // Cancelar: restaurar lo que había antes de editar
      if (backup.text != null) span.textContent = backup.text;
      else if (info)           span.textContent = info.nombre;
      span.classList.toggle("filled", !!backup.filled);
    }

    delete span._tapFillBackup;
    delete span._tapFillHandlers;
    actualizarProgresoMovil();
  }

  /* Permite eventos (selección, copiar/pegar dentro, menú contextual) que
     OCURRAN dentro de un placeholder en modo edición — el resto del
     documento sigue protegido por protegerLivePreviewAntiCopia(). */
  function permitirEventosEnPlaceholders() {
    const eventos = ["selectstart", "copy", "cut", "paste", "contextmenu", "dragstart"];
    eventos.forEach((ev) => {
      document.addEventListener(
        ev,
        (e) => {
          const t = e.target;
          if (!t || !t.closest) return;
          // Permitir solo si el evento es dentro de un placeholder en modo edición
          if (t.closest(".lp-ph.lp-ph-editing")) {
            e.stopImmediatePropagation();
          }
        },
        true /* capture: corremos antes que la protección global */
      );
    });
    // Permitir Ctrl/Cmd + C/X/A/V dentro del placeholder en edición
    document.addEventListener(
      "keydown",
      (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (!t.closest(".lp-ph.lp-ph-editing")) return;
        if ((e.ctrlKey || e.metaKey) &&
            ["c", "x", "a", "v"].includes((e.key || "").toLowerCase())) {
          e.stopImmediatePropagation();
        }
      },
      true
    );
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

    // En móvil, en pasos de campos/resumen, activamos el modo tap-fill
    // INMEDIATAMENTE (no esperamos a que el .docx se procese), para que el
    // usuario nunca vea el formulario aunque la previsualización esté cargando.
    const debe = isMobile() && pasoTapFillCompleto();
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

  // Envolver renderStep para reaplicar el modo móvil en CADA cambio de paso,
  // sin esperar a que se actualicen clases u observers.
  function envolverRenderStep() {
    if (typeof window.renderStep !== "function" || window.__tapFillRenderHooked) return;
    const original = window.renderStep;
    window.renderStep = function (step) {
      const r = original.apply(this, arguments);
      try { aplicarModoMovil(); } catch (_) {}
      // Re-aplicar en el siguiente tick por si renderStep hace trabajo asíncrono
      setTimeout(() => { try { aplicarModoMovil(); } catch (_) {} }, 0);
      return r;
    };
    window.__tapFillRenderHooked = true;
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
      editarInline(span, info);
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
    permitirEventosEnPlaceholders();
    instalarDelegacionClick();
    instalarHijackContinuar();
    envolverRenderStep();
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
