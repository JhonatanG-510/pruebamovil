
/* ═══════════════════════════════════════════════════════
   CONFIGURACIÓN FIREBASE
═══════════════════════════════════════════════════════ */
const firebaseConfig = {
  apiKey: "AIzaSyA3SBGZQPaIeBVLgQr6OmzNVAEgYMsCTg0",
  authDomain: "minutas-legales-colombia.firebaseapp.com",
  projectId: "minutas-legales-colombia",
  storageBucket: "minutas-legales-colombia.firebasestorage.app",
  messagingSenderId: "503105391766",
  appId: "1:503105391766:web:77ec372ea782cafc0b86b7",
  measurementId: "G-VBQB2K1JCE"
};

const ADMIN_EMAIL = "admin@minutaslegales.com";

/* Groq — gratuito, rápido, compatible con formato OpenAI */
const OPENAI_MODEL   = "llama-3.1-8b-instant";
const OPENAI_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const isConfigured = firebaseConfig.apiKey !== "TU_API_KEY";
if (!isConfigured) document.getElementById("config-banner").style.display = "block";

let app, auth, db, storage;
try {
  app     = firebase.initializeApp(firebaseConfig);
  auth    = firebase.auth();
  db      = firebase.firestore();
  storage = firebase.storage();
} catch(e) { console.warn("Firebase:", e); }

/* ── ESTADO GLOBAL ── */
let currentUser      = null;
let isAdmin          = false;
let minutasData      = [];
let minutasFiltradas = [];
let categoriasData   = [];
let currentMinuta    = null;
let currentStep      = 1;
let camposLlenados   = {};   // campos normales
let camposIALlenados = {};   // textos crudos del usuario para IA
let camposIAMejorados = {};  // textos ya mejorados por IA
let docxBlob         = null;
let pagoExitoso      = false;
let wompiConfig      = {};
let geminiConfig     = {};   // { apiKey: "..." }
let modoPrueba       = false; // Modo prueba: omite pago real
let currentWompiTransactionId = null;

/* Indica si la minuta actual tiene campos de IA */
let minutaTieneIA = false;
/* Nombres de placeholders de IA detectados en el Word */
let placeholdersIA = [];
/* Indica si la IA ya procesó los campos en la sesión actual */
let iaYaProcesada = false;


/* Minuta pendiente: se guarda cuando el usuario es redirigido al login */
let pendingMinutaId       = null;
let pendingCamposSnapshot = null;
let pendingResumeState    = null; // estado completo del modal a restaurar tras login

/* ── LÍMITE DE USO DE IA ── */
const IA_MAX_USOS   = 3;
const IA_BLOQUEO_MS = 60 * 60 * 1000; // 1 hora

function iaLimitKey() {
  const uid = currentUser ? currentUser.uid : "anon";
  const mid = currentMinuta ? (currentMinuta.id || currentMinuta.nombre || "none") : "none";
  return `ia_limite_${uid}_${mid}`;
}

function iaLimitCheck() {
  try {
    const raw  = localStorage.getItem(iaLimitKey());
    const data = raw ? JSON.parse(raw) : {};
    const usos = data.usos || 0;
    const bloqueadoHasta = data.bloqueadoHasta || 0;
    const now  = Date.now();
    if (bloqueadoHasta > now) {
      return { bloqueado: true, usos, bloqueadoHasta, msRestantes: bloqueadoHasta - now };
    }
    if (bloqueadoHasta && bloqueadoHasta <= now) {
      localStorage.removeItem(iaLimitKey());
      return { bloqueado: false, usos: 0, msRestantes: 0 };
    }
    return { bloqueado: false, usos, msRestantes: 0 };
  } catch(_) {
    return { bloqueado: false, usos: 0, msRestantes: 0 };
  }
}

function iaLimitIncrement() {
  try {
    const key  = iaLimitKey();
    const raw  = localStorage.getItem(key);
    const data = raw ? JSON.parse(raw) : {};
    const usos = (data.usos || 0) + 1;
    const bloqueadoHasta = usos >= IA_MAX_USOS ? Date.now() + IA_BLOQUEO_MS : 0;
    localStorage.setItem(key, JSON.stringify({ usos, bloqueadoHasta }));
    return usos >= IA_MAX_USOS;
  } catch(_) { return false; }
}

function iaLimitMensaje(msRestantes) {
  const totalMin = Math.ceil(msRestantes / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const tiempo = h > 0 ? `${h}h ${m}m` : `${m} minutos`;
  return `Has alcanzado el límite de ${IA_MAX_USOS} usos de IA para este contrato. Podrás volver a usarla en ${tiempo}.`;
}

/* ── PAGINADO ── */
const MINUTAS_PER_PAGE    = 10;
let minutasCurrentPage    = 1;
const CAMPOS_PER_PAGE     = 5;
let camposCurrentPage     = 1;
let camposTotalPages      = 1;
const ADMIN_ITEMS_PER_PAGE = 10;
let adminMinutasPage      = 1;
let adminMinutasAll       = [];
let adminVentasPage       = 1;
let adminVentasAll        = [];
const HISTORIAL_PER_PAGE  = 10;
let historialPage         = 1;
let historialAll          = [];

/* ── VARIABLES ADMIN para campos IA del Word subido ── */
let adminDocxBuffer    = null;  // ArrayBuffer del Word subido en admin
let adminPlaceholdersIA = [];   // placeholders IA detectados

/* ── VARIABLES CLAUSULAS OPCIONALES (ELECCION USUARIO) ── */
// En admin: lista de cláusulas detectadas con sus campos extra configurados
let adminClausulasEleccion = []; // [{id, titulo, preview, camposExtra: ["CAMPO1","CAMPO2"]}]
// En el flujo de compra: cláusulas detectadas en la minuta actual
let minutaClausulas        = []; // copia de currentMinuta.clausulasEleccion
// Elecciones del cliente: {clausulaId: true/false}
let eleccionesClausulas    = {};
// Campos extra llenados por el cliente para cláusulas incluidas
let camposClausulas        = {}; // {clausulaId_CAMPO: valor}

/* ─────────────────────────────────────────────────────
   NAVEGACIÓN Y AUTH
───────────────────────────────────────────────────── */
function showSection(id) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach(b => b.classList.remove("active"));
  const s = document.getElementById(id);
  if (s) s.classList.add("active");
  // Marca la sección activa en <body> para que CSS pueda reaccionar
  // (ej: ocultar el footer en "usuarios" y "admin").
  document.body.classList.remove("on-inicio","on-minutas","on-usuarios","on-asesoria","on-admin");
  document.body.classList.add("on-" + id);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (id === "minutas" && !minutasData.length) loadMinutas();
  if (id === "usuarios") {
    if (currentUser) {
      document.getElementById("view-auth").style.display = "none";
      document.getElementById("view-perfil").style.display = "block";
      document.getElementById("perfil-email-texto").textContent = currentUser.email;
      cargarHistorialUsuario();
    } else {
      document.getElementById("view-auth").style.display = "block";
      document.getElementById("view-perfil").style.display = "none";
    }
  }
  if (id === "admin" && isAdmin) {
    renderAdminData();
    loadAdminCategorias();
    cargarWompiConfigAdmin();
    cargarGeminiConfigAdmin();
    actualizarEstadoModoPrueba();
  }
  actualizarNavActivo(id);
}

function actualizarNavActivo(id) {
  document.querySelectorAll("nav .nav-link, .mobile-menu-panel .nav-link").forEach(b => b.classList.remove("active"));
  const mapa = {
    inicio:   ["nav-inicio",   "nav-inicio-mobile"],
    minutas:  ["nav-minutas",  "nav-minutas-mobile"],
    usuarios: ["nav-usuarios", "nav-usuarios-mobile"],
    asesoria: ["nav-asesoria", "nav-asesoria-mobile"],
    admin:    ["nav-admin",    "nav-admin-mobile"]
  };
  if (mapa[id]) {
    mapa[id].forEach(elId => {
      const el = document.getElementById(elId);
      if (el) el.classList.add("active");
    });
  }
}

/* ── AUTH STATE ── */
if (auth) {
  auth.onAuthStateChanged(user => {
    currentUser = user;
    isAdmin = user && user.email === ADMIN_EMAIL;
    if (user) {
      document.getElementById("auth-logged-out").style.display = "none";
      document.getElementById("auth-logged-in").style.display = "flex";
      document.getElementById("user-email").textContent = user.email;
      document.getElementById("nav-admin").style.display = isAdmin ? "inline-flex" : "none";
      const navAdminMobile = document.getElementById("nav-admin-mobile");
      if (navAdminMobile) navAdminMobile.style.display = isAdmin ? "flex" : "none";
      // Cambiar "Usuarios" → "Mi perfil"
      const navUsu = document.getElementById("nav-usuarios");
      if (navUsu) navUsu.textContent = "Mi perfil";
      const navUsuMobile = document.getElementById("nav-usuarios-mobile");
      if (navUsuMobile) navUsuMobile.textContent = "Mi perfil";
      // Menú móvil auth
      const mobileOut = document.getElementById("mobile-auth-logged-out");
      const mobileIn  = document.getElementById("mobile-auth-logged-in");
      const mobileEmail = document.getElementById("mobile-user-email-text");
      if (mobileOut) mobileOut.style.display = "none";
      if (mobileIn)  mobileIn.style.display  = "block";
      if (mobileEmail) mobileEmail.textContent = user.email;
    } else {
      document.getElementById("auth-logged-out").style.display = "flex";
      document.getElementById("auth-logged-in").style.display = "none";
      document.getElementById("nav-admin").style.display = "none";
      const navAdminMobile = document.getElementById("nav-admin-mobile");
      if (navAdminMobile) navAdminMobile.style.display = "none";
      // Restaurar "Usuarios"
      const navUsu = document.getElementById("nav-usuarios");
      if (navUsu) navUsu.textContent = "Usuarios";
      const navUsuMobile = document.getElementById("nav-usuarios-mobile");
      if (navUsuMobile) navUsuMobile.textContent = "Usuarios";
      // Menú móvil auth
      const mobileOut = document.getElementById("mobile-auth-logged-out");
      const mobileIn  = document.getElementById("mobile-auth-logged-in");
      if (mobileOut) mobileOut.style.display = "block";
      if (mobileIn)  mobileIn.style.display  = "none";
    }
  });
}

function authError(code) {
  const m = {
    "auth/wrong-password": "Contraseña incorrecta.",
    "auth/user-not-found": "No existe una cuenta con ese correo.",
    "auth/email-already-in-use": "Ya existe una cuenta con ese correo.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/invalid-email": "El correo no es válido.",
    "auth/too-many-requests": "Demasiados intentos. Espera un momento.",
    "auth/requires-recent-login": "Por seguridad, vuelve a iniciar sesión para hacer este cambio."
  };
  return m[code] || "Error de autenticación.";
}

function toast(msg, type) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (type === "error" ? " error" : type === "ok" ? " ok" : "");
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3800);
}

/* ── LOGIN ── */
document.getElementById("form-login").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-login");
  btn.disabled = true; btn.textContent = "Iniciando sesión...";
  try {
    await auth.signInWithEmailAndPassword(
      document.getElementById("login-email").value.trim(),
      document.getElementById("login-password").value
    );
    if (pendingMinutaId) {
      const savedId = pendingMinutaId;
      const state   = pendingResumeState;
      pendingMinutaId = null; pendingCamposSnapshot = null; pendingResumeState = null;
      toast("¡Bienvenido! Continúa donde lo dejaste.", "ok");
      await abrirMinuta(savedId);
      restaurarEstadoModal(state);
    } else {
      toast("¡Bienvenido!", "ok");
      showSection("inicio");
    }
  } catch(err) { toast(authError(err.code), "error"); }
  finally { btn.disabled = false; btn.textContent = "Iniciar Sesión"; }
});

/* ── REGISTRO ── */
document.getElementById("form-register").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-register");
  btn.disabled = true; btn.textContent = "Creando cuenta...";
  try {
    await auth.createUserWithEmailAndPassword(
      document.getElementById("reg-email").value.trim(),
      document.getElementById("reg-password").value
    );
    if (pendingMinutaId) {
      const savedId = pendingMinutaId;
      const state   = pendingResumeState;
      pendingMinutaId = null; pendingCamposSnapshot = null; pendingResumeState = null;
      toast("¡Cuenta creada! Continúa donde lo dejaste.", "ok");
      await abrirMinuta(savedId);
      restaurarEstadoModal(state);
    } else {
      toast("¡Cuenta creada correctamente!", "ok");
      showSection("inicio");
    }
  } catch(err) { toast(authError(err.code), "error"); }
  finally { btn.disabled = false; btn.textContent = "Crear Cuenta"; }
});

/* ── LOGOUT ── */
document.getElementById("btn-logout").addEventListener("click", async () => {
  await auth.signOut();
  toast("Sesión cerrada.");
  showSection("inicio");
});

const btnLogoutMobile = document.getElementById("btn-logout-mobile");
if (btnLogoutMobile) {
  btnLogoutMobile.addEventListener("click", async () => {
    cerrarMenuMovil();
    if (auth) await auth.signOut();
    toast("Sesión cerrada.");
    showSection("inicio");
  });
}

/* ── MENÚ HAMBURGUESA MÓVIL ── */
function toggleMenuMovil() {
  const menu = document.getElementById("mobile-menu");
  const btn  = document.getElementById("hamburger-btn");
  const open = menu.classList.contains("open");
  if (open) {
    menu.classList.remove("open");
    btn.classList.remove("open");
    document.body.style.overflow = "";
  } else {
    menu.classList.add("open");
    btn.classList.add("open");
    document.body.style.overflow = "hidden";
  }
}

function cerrarMenuMovil() {
  const menu = document.getElementById("mobile-menu");
  const btn  = document.getElementById("hamburger-btn");
  menu.classList.remove("open");
  btn.classList.remove("open");
  document.body.style.overflow = "";
}

function cerrarMenuMovilFondo(e) {
  if (e.target === document.getElementById("mobile-menu")) cerrarMenuMovil();
}

/* (tipoCampoActual y seleccionarTipoCampo ya no son necesarios: ahora se usan
   dos inputs independientes para campos normales y campos largos) */

/* ── CAMBIAR EMAIL ── */
document.getElementById("form-cambiar-email").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-cambiar-email");
  btn.disabled = true; btn.textContent = "Actualizando...";
  try {
    const credential = firebase.auth.EmailAuthProvider.credential(currentUser.email, document.getElementById("email-password-confirm").value);
    await currentUser.reauthenticateWithCredential(credential);
    await currentUser.updateEmail(document.getElementById("nuevo-email").value.trim());
    toast("Correo actualizado correctamente.", "ok");
    document.getElementById("perfil-email-texto").textContent = currentUser.email;
    document.getElementById("user-email").textContent = currentUser.email;
    document.getElementById("form-cambiar-email").reset();
  } catch(err) { toast(authError(err.code), "error"); }
  finally { btn.disabled = false; btn.textContent = "Actualizar correo"; }
});

/* ── CAMBIAR CONTRASEÑA ── */
document.getElementById("form-cambiar-pass").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-cambiar-pass");
  btn.disabled = true; btn.textContent = "Actualizando...";
  const passActual = document.getElementById("pass-actual").value;
  const passNueva  = document.getElementById("pass-nueva").value;
  const passConf   = document.getElementById("pass-confirmar").value;
  if (passNueva !== passConf) {
    toast("Las contraseñas no coinciden.", "error");
    btn.disabled = false; btn.textContent = "Actualizar contraseña";
    return;
  }
  try {
    const credential = firebase.auth.EmailAuthProvider.credential(currentUser.email, passActual);
    await currentUser.reauthenticateWithCredential(credential);
    await currentUser.updatePassword(passNueva);
    toast("Contraseña actualizada correctamente.", "ok");
    document.getElementById("form-cambiar-pass").reset();
  } catch(err) { toast(authError(err.code), "error"); }
  finally { btn.disabled = false; btn.textContent = "Actualizar contraseña"; }
});

/* ── HISTORIAL ── */
async function cargarHistorialUsuario() {
  const cont   = document.getElementById("perfil-historial");
  const pagCont = document.getElementById("perfil-historial-pagination");
  cont.innerHTML = "<p class='text-muted'>Cargando...</p>";
  pagCont.innerHTML = "";
  if (!db || !currentUser) { cont.innerHTML = "<p class='text-muted'>No disponible.</p>"; return; }
  try {
    const snap = await db.collection("ventas").where("userId","==",currentUser.uid).get();
    historialAll = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => {
        const aT = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        const bT = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return bT - aT;
      });
    historialPage = 1;
    renderHistorial();
  } catch(err) { cont.innerHTML = `<p class='text-muted'>Error: ${err.message}</p>`; }
}

function renderHistorial() {
  const cont   = document.getElementById("perfil-historial");
  const pagCont = document.getElementById("perfil-historial-pagination");
  if (!historialAll.length) { cont.innerHTML = "<p class='text-muted'>Aún no has realizado compras.</p>"; pagCont.innerHTML = ""; return; }
  const totalPages = Math.ceil(historialAll.length / HISTORIAL_PER_PAGE);
  const start = (historialPage - 1) * HISTORIAL_PER_PAGE;
  const slice = historialAll.slice(start, start + HISTORIAL_PER_PAGE);
  cont.innerHTML = slice.map(v => {
    const fecha = v.createdAt && v.createdAt.toDate
      ? v.createdAt.toDate().toLocaleString("es-CO", { year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit" })
      : "—";
    return `<div class="historial-item">
      <div class="historial-item-nombre">${esc(v.minutaNombre||"Minuta")}</div>
      <div class="historial-item-meta">${fecha} · ${esc(v.metodoPago||"—")}</div>
      <div class="historial-item-precio">$${Number(v.precio||0).toLocaleString("es-CO")} COP <span class="estado-pagado" style="margin-left:8px;">Pagado</span></div>
    </div>`;
  }).join("");
  renderPagination(pagCont, historialPage, totalPages, p => { historialPage = p; renderHistorial(); });
}

/* ─────────────────────────────────────────────────────
   CATEGORÍAS
───────────────────────────────────────────────────── */
const CATS_DEFAULT = ["Arrendamiento","Compraventa","Laboral","Sociedad","Otro"];

async function loadCategorias() {
  if (!db) { categoriasData = [...CATS_DEFAULT]; renderFiltros(); return; }
  try {
    const snap = await db.collection("categorias").orderBy("nombre").get();
    if (snap.empty) {
      for (const nombre of CATS_DEFAULT) await db.collection("categorias").add({ nombre });
      categoriasData = [...CATS_DEFAULT];
    } else {
      categoriasData = snap.docs.map(d => d.data().nombre);
    }
  } catch(e) { categoriasData = [...CATS_DEFAULT]; }
  renderFiltros();
}

function renderFiltros() {
  const container = document.getElementById("filtros-container");
  container.innerHTML = `<button class="filtro-btn active" data-cat="todos">Todas</button>`;
  categoriasData.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = "filtro-btn";
    btn.dataset.cat = cat;
    btn.textContent = cat;
    btn.onclick = () => {
      document.querySelectorAll(".filtro-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      minutasFiltradas = cat === "todos" ? minutasData : minutasData.filter(m => m.categoria === cat);
      minutasCurrentPage = 1;
      renderMinutas(minutasFiltradas);
    };
    container.appendChild(btn);
  });
  container.querySelector("[data-cat='todos']").onclick = () => {
    document.querySelectorAll(".filtro-btn").forEach(b => b.classList.remove("active"));
    container.querySelector("[data-cat='todos']").classList.add("active");
    minutasFiltradas = minutasData;
    minutasCurrentPage = 1;
    renderMinutas(minutasData);
  };
}

async function loadAdminCategorias() {
  const list   = document.getElementById("cat-tag-list");
  const select = document.getElementById("adm-categoria");
  if (!db) { categoriasData = [...CATS_DEFAULT]; } else {
    try {
      const snap = await db.collection("categorias").orderBy("nombre").get();
      categoriasData = snap.docs.map(d => ({ id: d.id, nombre: d.data().nombre }));
    } catch(e) { categoriasData = CATS_DEFAULT.map(n => ({ nombre: n })); }
  }
  if (!categoriasData.length) { list.innerHTML = "<span class='text-muted'>No hay categorías aún.</span>"; } else {
    list.innerHTML = categoriasData.map(c => `<span class="cat-tag">${esc(c.nombre || c)}<button onclick="eliminarCategoria('${c.id||""}')" title="Eliminar">✕</button></span>`).join("");
  }
  const nombres = categoriasData.map(c => c.nombre || c);
  select.innerHTML = nombres.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
}

async function agregarCategoria() {
  const input = document.getElementById("nueva-cat-input");
  const nombre = input.value.trim();
  if (!nombre) { toast("Escribe el nombre de la categoría.", "error"); return; }
  if (!db) { toast("Firebase no configurado.", "error"); return; }
  try {
    await db.collection("categorias").add({ nombre });
    toast("Categoría agregada.", "ok");
    input.value = "";
    await loadAdminCategorias();
    await loadCategorias();
  } catch(e) { toast("Error al agregar: " + e.message, "error"); }
}

async function eliminarCategoria(id) {
  if (!id) { toast("No se puede eliminar (sin ID).", "error"); return; }
  if (!confirm("¿Eliminar esta categoría?")) return;
  try {
    await db.collection("categorias").doc(id).delete();
    toast("Categoría eliminada.");
    await loadAdminCategorias();
    await loadCategorias();
  } catch(e) { toast("Error: " + e.message, "error"); }
}

/* ─────────────────────────────────────────────────────
   MINUTAS — CATÁLOGO
───────────────────────────────────────────────────── */
async function loadMinutas() {
  if (!db) {
    document.getElementById("minutas-grid").innerHTML = "";
    document.getElementById("minutas-empty").style.display = "block";
    document.getElementById("minutas-empty").textContent = "Firebase no está configurado.";
    actualizarHeroStatusPill();
    return;
  }
  document.getElementById("minutas-grid").innerHTML = '<div class="loading-spinner"></div>';
  document.getElementById("minutas-empty").style.display = "none";
  document.getElementById("minutas-pagination").innerHTML = "";
  try {
    const snap = await db.collection("minutas").orderBy("createdAt","desc").get();
    minutasData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    minutasFiltradas = minutasData;
    if (!categoriasData.length) await loadCategorias();
    minutasCurrentPage = 1;
    renderMinutas(minutasData);
    actualizarHeroStatusPill();
  } catch(err) {
    document.getElementById("minutas-grid").innerHTML = "";
    document.getElementById("minutas-empty").style.display = "block";
    document.getElementById("minutas-empty").textContent = "Error: " + err.message;
    actualizarHeroStatusPill();
  }
}

/* ─── Pill de estado en el hero (ej: "12 minutas activas en 5 categorías") ─── */
async function precargarHeroStatusPill() {
  // Si aún no se ha entrado a la sección Minutas, no se ha llamado loadMinutas.
  // Hacemos una carga ligera de conteos para mostrar la pill desde el inicio.
  if (!db) { actualizarHeroStatusPill(); return; }
  try {
    if (!minutasData.length) {
      const snap = await db.collection("minutas").get();
      // No sobreescribimos minutasData con datos parciales; solo conteo.
      const total = snap.size;
      window.__heroMinutasCount = total;
    }
    if (!categoriasData.length) {
      try { await loadCategorias(); } catch(_) {}
    }
  } catch(_) { /* silencioso: caemos en defaults */ }
  actualizarHeroStatusPill();
}

function actualizarHeroStatusPill() {
  const el = document.getElementById("hero-status-pill-text");
  if (!el) return;
  const totalMin = (minutasData && minutasData.length) || window.__heroMinutasCount || 0;
  const totalCat = (categoriasData && categoriasData.length) || 0;

  if (!totalMin && !totalCat) {
    el.innerHTML = "Catálogo en línea · listo para usar";
    return;
  }
  if (!totalCat) {
    el.innerHTML = "<strong>" + totalMin + "</strong> minuta" + (totalMin === 1 ? "" : "s") + " activa" + (totalMin === 1 ? "" : "s");
    return;
  }
  el.innerHTML =
    "<strong>" + totalMin + "</strong> minuta" + (totalMin === 1 ? "" : "s") + " activa" + (totalMin === 1 ? "" : "s") +
    " en <strong>" + totalCat + "</strong> categoría" + (totalCat === 1 ? "" : "s");
}

function renderMinutas(list) {
  const grid    = document.getElementById("minutas-grid");
  const empty   = document.getElementById("minutas-empty");
  const pagCont = document.getElementById("minutas-pagination");
  grid.innerHTML = ""; pagCont.innerHTML = "";
  if (!list.length) { empty.style.display = "block"; return; }
  empty.style.display = "none";
  const totalPages = Math.ceil(list.length / MINUTAS_PER_PAGE);
  if (minutasCurrentPage > totalPages) minutasCurrentPage = 1;
  const start = (minutasCurrentPage - 1) * MINUTAS_PER_PAGE;
  const slice = list.slice(start, start + MINUTAS_PER_PAGE);
  slice.forEach(m => {
    const card = document.createElement("div");
    card.className = "minuta-card";
    const aiTag = (m.tieneIA && (m.placeholdersIA || []).length)
      ? `<span class="minuta-ai-badge">Redacción IA</span>` : "";
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div class="minuta-badge">${esc(m.categoria||"Legal")}${aiTag}</div>
        <button class="btn-eye" onclick="previsualizarMinuta('${m.id}',event)">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" xmlns="http://www.w3.org/2000/svg"><path d="M1 10s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z"/><circle cx="10" cy="10" r="3"/></svg>
          Vista previa
        </button>
      </div>
      <h3>${esc(m.nombre)}</h3>
      <p>${esc(m.descripcion||"")}</p>
      <div class="minuta-campos">
        <strong>Campos personalizables:</strong>
        <span>${(m.campos||[]).length ? (m.campos.length + " campo" + (m.campos.length !== 1 ? "s" : "")) : "Ninguno"}</span>
      </div>
      <div class="minuta-footer">
        ${Number(m.precio||0) === 0
          ? `<span class="precio-gratis">Gratis</span>`
          : `<span class="precio">$${Number(m.precio||0).toLocaleString("es-CO")} COP</span>`
        }
        <button class="btn btn-primary btn-sm" onclick="abrirMinuta('${m.id}')">Adquirir</button>
      </div>`;
    grid.appendChild(card);
  });
  renderPagination(pagCont, minutasCurrentPage, totalPages, p => {
    minutasCurrentPage = p;
    renderMinutas(list);
    document.getElementById("minutas").scrollIntoView({ behavior:"smooth", block:"start" });
  });
}

document.getElementById("buscador").addEventListener("input", e => {
  const t = e.target.value.toLowerCase();
  minutasFiltradas = minutasData.filter(m =>
    m.nombre.toLowerCase().includes(t) ||
    (m.descripcion||"").toLowerCase().includes(t) ||
    (m.categoria||"").toLowerCase().includes(t)
  );
  minutasCurrentPage = 1;
  renderMinutas(minutasFiltradas);
});

/* ─────────────────────────────────────────────────────
   PAGINADO GENÉRICO
───────────────────────────────────────────────────── */
function renderPagination(container, currentPage, totalPages, onPageChange) {
  container.innerHTML = "";
  if (totalPages <= 1) return;
  const prevBtn = document.createElement("button");
  prevBtn.className = "page-btn"; prevBtn.textContent = "‹"; prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => onPageChange(currentPage - 1);
  container.appendChild(prevBtn);
  const pages = getPaginationRange(currentPage, totalPages);
  pages.forEach(p => {
    if (p === "...") {
      const dots = document.createElement("span");
      dots.textContent = "…"; dots.style.cssText = "padding:0 6px;color:var(--text-muted);display:inline-flex;align-items:center;";
      container.appendChild(dots);
    } else {
      const btn = document.createElement("button");
      btn.className = "page-btn" + (p === currentPage ? " active" : ""); btn.textContent = p;
      btn.onclick = () => onPageChange(p);
      container.appendChild(btn);
    }
  });
  const nextBtn = document.createElement("button");
  nextBtn.className = "page-btn"; nextBtn.textContent = "›"; nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => onPageChange(currentPage + 1);
  container.appendChild(nextBtn);
}

function getPaginationRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const range = [];
  if (current <= 4) {
    for (let i = 1; i <= 5; i++) range.push(i); range.push("..."); range.push(total);
  } else if (current >= total - 3) {
    range.push(1); range.push("..."); for (let i = total - 4; i <= total; i++) range.push(i);
  } else {
    range.push(1); range.push("..."); range.push(current - 1); range.push(current); range.push(current + 1); range.push("..."); range.push(total);
  }
  return range;
}

/* ─────────────────────────────────────────────────────
   MODAL — FLUJO DE COMPRA
───────────────────────────────────────────────────── */
async function abrirMinuta(id) {
  currentMinuta    = minutasData.find(m => m.id === id);
  if (!currentMinuta) return;
  currentStep      = 1;
  camposLlenados   = {};
  camposIALlenados = {};
  camposIAMejorados = {};
  camposCurrentPage = 1;
  docxBlob         = null;
  currentWompiTransactionId = null;
  iaYaProcesada    = false;
  pagoExitoso      = false;
  // Reset estado de la previsualización en vivo
  livePreviewReady = false;
  const _lpCont = document.getElementById("live-preview-content");
  if (_lpCont) _lpCont.innerHTML = `<div class="live-preview-empty"><div class="loading-spinner" style="margin:0 auto 12px;"></div>Cargando previsualización…</div>`;
  const _lpBody = document.getElementById("modal-body");
  if (_lpBody) _lpBody.classList.remove("with-live-preview", "lp-mobile-open");
  const _lpModal = document.getElementById("modal-compra");
  if (_lpModal) _lpModal.classList.remove("modal--with-preview");

  minutaTieneIA    = !!(currentMinuta.tieneIA && (currentMinuta.placeholdersIA||[]).length);
  placeholdersIA   = currentMinuta.placeholdersIA || [];

  // Cláusulas opcionales
  minutaClausulas   = currentMinuta.clausulasEleccion || [];
  eleccionesClausulas = {};
  camposClausulas   = {};

  document.getElementById("modal-nombre-titulo").textContent = currentMinuta.nombre;
  const precioDisplay = Number(currentMinuta.precio||0) === 0 ? "Gratis" : `$${Number(currentMinuta.precio||0).toLocaleString("es-CO")} COP`;
  document.getElementById("modal-precio-header").textContent = precioDisplay;
  document.getElementById("pay-total-monto").textContent     = precioDisplay;

  buildStepsBar();
  renderStep(1);
  document.getElementById("modal-overlay").classList.add("open");
  document.body.style.overflow = "hidden";

  // Cargar SOLO la plantilla de trabajo (docxBase64) en el blob para el reemplazo.
  // Nunca usar docxPreviewBase64 aquí — ese es solo para la previsualización de 10 segundos.
  (async () => {
    const b64 = currentMinuta.docxBase64;
    if (b64) {
      try {
        const binary = atob(b64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        docxBlob = new Blob([bytes.buffer], { type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        try { await inicializarLivePreview(); } catch(_) {}
        return;
      } catch(e) { console.warn("[abrirMinuta] Error decodificando docxBase64:", e); }
    }
    if (currentMinuta.archivoURL) {
      try {
        const resp = await fetch(currentMinuta.archivoURL, { mode: "cors" });
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          docxBlob = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        } else {
          console.warn("[abrirMinuta] fetch archivoURL respondió con estado:", resp.status);
        }
      } catch(fetchErr) {
        console.warn("[abrirMinuta] Error cargando archivoURL (posible CORS o red):", fetchErr);
        // El docxBlob queda null; al intentar descargar se mostrará el error al usuario
      }
    }
    if (!docxBlob) {
      console.warn("[abrirMinuta] No se pudo cargar la plantilla. Verifica CORS en Firebase Storage y las reglas de acceso público.");
      const cont = document.getElementById("live-preview-content");
      if (cont) cont.innerHTML = `<div class="live-preview-empty">No fue posible cargar la previsualización del documento.</div>`;
    } else {
      try { await inicializarLivePreview(); } catch(_) {}
    }
  })();
}

function tieneClausulasOpcionales() {
  return minutaClausulas && minutaClausulas.length > 0;
}

/* Construye la barra de pasos dinámicamente según si hay IA o no */
function buildStepsBar() {
  const bar = document.getElementById("steps-bar-container");
  const campos = currentMinuta.campos || [];
  const tieneIA = minutaTieneIA;

  const steps = [];
  if (campos.length) steps.push({ label: "Mis datos" });
  if (tieneClausulasOpcionales()) steps.push({ label: "Cláusulas" });
  if (tieneIA) steps.push({ label: "Hechos y pretensiones" });
  steps.push({ label: "Pago" });
  steps.push({ label: "Descargar" });

  bar.innerHTML = steps.map((s, i) => `
    <div class="step-item${i === 0 ? ' active' : ''}" id="step-ind-${i+1}">
      <span class="step-num">${i+1}</span>${s.label}
    </div>`).join("");
}

/* Mapea paso lógico a panel real.
   Paneles físicos disponibles:
     2  = Mis datos (campos normales)
     "clausulas" = step-clausulas
     3  = IA
     4  = Pago
     5  = Descarga
*/
function tieneCamposMinuta() {
  if (!currentMinuta) return false;
  const c  = (currentMinuta.campos      || []).length;
  const cl = (currentMinuta.camposLargo || []).length;
  return (c + cl) > 0;
}

// Devuelve una lista ordenada de IDs de panel para el flujo actual
function getFlowPanels() {
  const panels = [];
  if (tieneCamposMinuta())       panels.push("2");
  if (tieneClausulasOpcionales()) panels.push("clausulas");
  if (minutaTieneIA)              panels.push("3");
  panels.push("4"); // pago
  panels.push("5"); // descarga
  return panels;
}

function getStepPanelId(step) {
  const panels = getFlowPanels();
  const panel = panels[step - 1];
  if (!panel) return 5;
  return panel === "clausulas" ? "clausulas" : Number(panel);
}

function getTotalSteps() {
  return getFlowPanels().length;
}

function renderStep(step) {
  currentStep = step;
  const totalSteps = getTotalSteps();
  const panelId = getStepPanelId(step);

  // Si ya pagó y llega al paso de pago, saltarlo directamente
  if (pagoExitoso && panelId === 4) {
    renderStep(step + 1);
    return;
  }

  // Mostrar/ocultar paneles
  [1, 2, 3, 4, 5].forEach(i => {
    const panel = document.getElementById("step-" + i);
    if (panel) panel.classList.remove("active");
  });
  // Panel cláusulas
  const panelClausulas = document.getElementById("step-clausulas");
  if (panelClausulas) panelClausulas.classList.remove("active");

  if (panelId === "clausulas") {
    if (panelClausulas) panelClausulas.classList.add("active");
  } else {
    const panel = document.getElementById("step-" + panelId);
    if (panel) panel.classList.add("active");
    // Asegurar que el panel 1 (vista previa) nunca quede activo en el flujo de compra
    const p1 = document.getElementById("step-1");
    if (p1) p1.classList.remove("active");
  }

  // Actualizar indicadores de barra
  const bars = document.querySelectorAll("#steps-bar-container .step-item");
  bars.forEach((el, idx) => {
    el.classList.remove("active","done");
    if (idx + 1 === step) el.classList.add("active");
    else if (idx + 1 < step) el.classList.add("done");
  });

  const back = document.getElementById("btn-step-back");
  const next = document.getElementById("btn-step-next");
  back.style.display = step > 1 && step < totalSteps ? "inline-flex" : "none";

  if (panelId === 2) {
    buildCamposForm();
    updateStep2FooterBtn();
  } else if (panelId === "clausulas") {
    buildClausulasForm();
    next.style.display = "inline-flex";
    next.textContent = "Confirmar selección →";
    next.style.background = "";
    next.disabled = false;
  } else if (panelId === 3) {
    buildCamposIAForm();
    next.style.display = "inline-flex";
    next.textContent = "Continuar al pago →";
    next.style.background = "";
  } else if (panelId === 4) {
    next.style.display = "none";
    renderPagoStep();
  } else if (panelId === 5) {
    next.style.display = "none";
    back.style.display = "none";
    setupDescarga();
  }

  // Mostrar/ocultar la vista previa en vivo según el paso actual
  aplicarClaseLivePreviewSegunPaso();
  actualizarLivePreview();
}

/* ── CAMPOS (NORMALES + LARGOS) CON PAGINADO ── */
function buildAllCamposList() {
  // Unifica campos normales y campos largos en una sola lista con tipo
  const normales = (currentMinuta.campos      || []).map(n => ({ nombre: n, tipo: "normal" }));
  const largos   = (currentMinuta.camposLargo || []).map(n => ({ nombre: n, tipo: "largo"  }));
  return [...normales, ...largos];
}

function buildCamposForm() {
  const lista = buildAllCamposList();
  camposTotalPages = lista.length ? Math.ceil(lista.length / CAMPOS_PER_PAGE) : 1;
  renderCamposPage();
}

function renderCamposPage() {
  const cont    = document.getElementById("campos-dinamicos");
  const infoEl  = document.getElementById("campos-pag-info");
  const navEl   = document.getElementById("campos-nav");
  const navInfo = document.getElementById("campos-nav-info");
  const btnPrev = document.getElementById("btn-campos-prev");
  const btnNext = document.getElementById("btn-campos-next");
  cont.innerHTML = "";
  const lista = buildAllCamposList();
  if (!lista.length) {
    cont.innerHTML = "<p class='text-muted'>Esta minuta no tiene campos personalizables. Puedes continuar al pago.</p>";
    infoEl.textContent = ""; navEl.style.display = "none"; updateStep2FooterBtn(); return;
  }
  const start = (camposCurrentPage - 1) * CAMPOS_PER_PAGE;
  const slice = lista.slice(start, start + CAMPOS_PER_PAGE);
  infoEl.textContent = `Campos ${start+1}–${Math.min(start+CAMPOS_PER_PAGE, lista.length)} de ${lista.length}`;
  slice.forEach(({ nombre: campo, tipo }) => {
    const div    = document.createElement("div");
    div.className = "form-group";
    if (tipo === "largo") {
      div.innerHTML = `
        <label style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;">${esc(campo)}
          <span style="background:rgba(26,58,92,0.09);color:var(--primary);font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:10px;">Texto libre</span>
        </label>
        <textarea class="form-control campo-input" data-campo="${esc(campo)}"
          rows="8" style="min-height:160px;resize:vertical;font-size:0.92rem;line-height:1.7;"
          placeholder="Escribe aquí ${esc(campo)}. Puedes usar Enter para separar párrafos o enumeraciones (PRIMERO., SEGUNDO., etc.).">${esc(camposLlenados[campo]||"")}</textarea>
        <p class="form-hint">Puedes presionar Enter para hacer saltos de línea. El texto se insertará tal cual en el documento Word.</p>`;
    } else {
      div.innerHTML = `
        <label>${esc(campo)}</label>
        <input type="text" class="form-control campo-input" data-campo="${esc(campo)}"
          placeholder="Escribe: ${esc(campo)}" value="${esc(camposLlenados[campo]||"")}" />`;
    }
    cont.appendChild(div);
  });
  if (camposTotalPages > 1) {
    navEl.style.display = "flex"; navInfo.textContent = `Página ${camposCurrentPage} de ${camposTotalPages}`;
    btnPrev.disabled = camposCurrentPage === 1;
    btnNext.style.display = camposCurrentPage < camposTotalPages ? "inline-flex" : "none";
  } else { navEl.style.display = "none"; }
  updateStep2FooterBtn();
}

function saveCamposActuales() {
  document.querySelectorAll(".campo-input").forEach(inp => {
    if (inp.value.trim()) camposLlenados[inp.dataset.campo] = inp.value.trim();
  });
}

function validateCamposActuales() {
  let valid = true;
  document.querySelectorAll(".campo-input").forEach(inp => {
    if (!inp.value.trim()) { inp.style.borderColor = "var(--danger)"; valid = false; }
    else inp.style.borderColor = "";
  });
  return valid;
}

function camposPrevPage() {
  saveCamposActuales();
  if (camposCurrentPage > 1) { camposCurrentPage--; renderCamposPage(); }
}

function camposNextPage() {
  if (!validateCamposActuales()) { toast("Completa todos los campos antes de continuar.", "error"); return; }
  saveCamposActuales();
  if (camposCurrentPage < camposTotalPages) { camposCurrentPage++; renderCamposPage(); }
}

function updateStep2FooterBtn() {
  const next = document.getElementById("btn-step-next");
  if (camposTotalPages > 1 && camposCurrentPage < camposTotalPages) {
    next.style.display = "none";
  } else {
    next.style.display = "inline-flex";
    next.textContent = "Continuar →";
  }
}

/* ── CAMPOS DE IA (hechos, pretensiones, etc.) ── */
function buildCamposIAForm() {
  const cont = document.getElementById("campos-ia-dinamicos");
  cont.innerHTML = "";
  if (!placeholdersIA.length) {
    cont.innerHTML = "<p class='text-muted'>No se detectaron espacios de IA en este documento.</p>"; return;
  }

  // Verificar límite de uso antes de mostrar el formulario
  const limite = iaLimitCheck();
  if (limite.bloqueado) {
    const msg = iaLimitMensaje(limite.msRestantes);
    cont.innerHTML = `
      <div style="background:var(--danger-bg,#fff0f0);border:1.5px solid var(--danger,#dc2626);border-radius:10px;padding:20px 22px;text-align:center;">
        <div style="font-size:2rem;margin-bottom:8px;">🚫</div>
        <p style="font-weight:700;color:var(--danger,#dc2626);margin:0 0 6px;">Límite de IA alcanzado</p>
        <p style="color:#555;margin:0;font-size:0.93rem;" id="ia-limite-countdown">${esc(msg)}</p>
      </div>`;
    // Deshabilitar botón "Continuar"
    const next = document.getElementById("btn-step-next");
    if (next) { next.disabled = true; next.style.opacity = "0.5"; }
    // Actualizar el countdown cada minuto
    clearInterval(window._iaCountdownInterval);
    window._iaCountdownInterval = setInterval(() => {
      const l2 = iaLimitCheck();
      const el = document.getElementById("ia-limite-countdown");
      if (!el) { clearInterval(window._iaCountdownInterval); return; }
      if (!l2.bloqueado) {
        clearInterval(window._iaCountdownInterval);
        buildCamposIAForm(); // reconstruir formulario al expirar
        if (next) { next.disabled = false; next.style.opacity = ""; }
      } else {
        el.textContent = iaLimitMensaje(l2.msRestantes);
      }
    }, 60000);
    return;
  }

  // Restaurar botón "Continuar" si estaba deshabilitado por límite
  const next = document.getElementById("btn-step-next");
  if (next) { next.disabled = false; next.style.opacity = ""; }

  // Ocultar el panel introductorio antiguo: el chat tiene su propio encabezado
  const intro = cont.previousElementSibling;
  if (intro && intro.tagName !== "P") intro.style.display = "none";

  // Construir interfaz de chat tipo WhatsApp para el usuario final
  cont.innerHTML = `
    <div class="ia-chat" id="ia-chat">
      <div class="ia-chat-header">
        <div class="ia-chat-avatar">⚖️</div>
        <div class="ia-chat-meta">
          <div class="ia-chat-title">Asistente legal</div>
          <div class="ia-chat-status"><span class="ia-chat-status-dot"></span>Te ayudo a redactar tu documento</div>
        </div>
      </div>
      <div class="ia-chat-messages" id="ia-chat-messages" aria-live="polite"></div>
      <div class="ia-chat-composer">
        <textarea class="ia-chat-input" id="ia-chat-input" rows="1"
          placeholder="Escribe tu respuesta… (Shift+Enter para una nueva línea)"></textarea>
        <button type="button" class="ia-chat-send" id="ia-chat-send"
          onclick="enviarMensajeChatIA()" title="Enviar (Enter)" aria-label="Enviar">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M2.4 20.6 22 12 2.4 3.4l.01 6.69L17 12 2.41 13.91z"/>
          </svg>
        </button>
      </div>
      <div class="ia-chat-hint">
        <kbd>Enter</kbd> envía
        <span class="ia-chat-hint-sep">•</span>
        <kbd>Shift</kbd>+<kbd>Enter</kbd> nueva línea
        <span class="ia-chat-hint-sep">•</span>
        <span class="ia-chat-hint-edit">Pulsa <span class="ia-chat-hint-pencil">✎</span> en una respuesta para editarla</span>
      </div>
    </div>
  `;

  // Pintar el chat según el estado actual de las respuestas
  renderChatIA();

  // Atajos de teclado: Enter envía, Shift+Enter nueva línea
  const inp = document.getElementById("ia-chat-input");
  if (inp) {
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        enviarMensajeChatIA();
      }
    });
    // Auto-resize del textarea
    inp.addEventListener("input", () => {
      inp.style.height = "auto";
      inp.style.height = Math.min(inp.scrollHeight, 140) + "px";
    });
  }

  actualizarBotonChatIA();
  if (typeof actualizarLivePreview === "function") {
    try { actualizarLivePreview(); } catch(_) {}
  }
}

/* ── CHAT IA: helpers ── */
function _chatPreguntaIA(placeholder) {
  const label = humanizarPlaceholderIA(placeholder);
  const lo    = label.toLowerCase();
  const tipo  = detectarTipoDocumento(currentMinuta);

  // Hechos
  if (lo.includes("hecho")) {
    if (tipo.tipo === "contrato") {
      return "Cuéntame los antecedentes o el contexto del contrato: ¿cómo llegaron las partes a este acuerdo? Descríbelo con tus propias palabras.";
    }
    return "Cuéntame los hechos: ¿qué fue lo que pasó? Descríbelo con tus propias palabras, como si me lo estuvieras contando. Si son varios hechos, los puedes separar (Primero..., Segundo..., etc.).";
  }

  // Pretensiones / solicitudes / peticiones — adaptado al tipo de documento
  if (lo.includes("pretensi") || lo.includes("petici") || lo.includes("solicit")) {
    switch (tipo.tipo) {
      case "peticion":
        return "Ahora cuéntame: ¿qué le quieres pedir o solicitar formalmente a la entidad? Lista cada solicitud que tengas (1, 2, 3...). Recuerda que la entidad debe responderte en máximo 15 días hábiles.";
      case "tutela":
        return "Ahora cuéntame: ¿qué le pides al juez constitucional? ¿Qué derecho fundamental quieres que se proteja y de qué manera (que ordene tal cosa, que se restablezca tal otra...)? Lista cada pretensión.";
      case "demanda":
        return "Ahora cuéntame: ¿qué le pides al juez? Lista cada pretensión que quieras incluir (declaraciones, condenas, indemnizaciones, etc.).";
      case "queja":
        return "Cuéntame qué le pides a la entidad u organismo: ¿qué quieres que investiguen, sancionen o corrijan? Lista cada solicitud.";
      case "denuncia":
        return "Cuéntame qué le pides a la autoridad: ¿que investiguen los hechos, que se inicie un proceso penal, que se tomen medidas de protección? Lista cada solicitud.";
      case "recurso":
        return "Cuéntame qué le pides a la autoridad que resolverá el recurso: ¿que revoque, modifique o confirme la decisión? Sé específico con lo que pides.";
      case "poder":
        return "Cuéntame qué facultades quieres otorgarle a tu apoderado: ¿qué actos puede hacer en tu nombre? Lista cada facultad.";
      case "desistimiento":
        return "Cuéntame qué quieres desistir o renunciar exactamente y, si quieres, los motivos generales (sin entrar en detalles confidenciales).";
      default:
        return "Cuéntame qué quieres pedir o lograr con este documento. Lista cada solicitud que tengas, separada con números o saltos de línea.";
    }
  }

  // Fundamentos / derechos
  if (lo.includes("fundamento") || lo.includes("derecho") || lo.includes("razon")) {
    if (tipo.tipo === "tutela") {
      return "Cuéntame los fundamentos: ¿qué derechos fundamentales consideras que te están vulnerando y por qué? (No necesitas citar artículos exactos — yo te ayudo con la forma.)";
    }
    if (tipo.tipo === "peticion") {
      return "Cuéntame los fundamentos: ¿en qué te basas para hacer esta petición? Si conoces normas (leyes, decretos), menciónalas; si no, describe en tus palabras por qué consideras que es procedente.";
    }
    return "Cuéntame los fundamentos: ¿en qué te basas para hacer esta solicitud? ¿Cuáles son los motivos de fondo? (Yo me encargo de citar las normas correctamente).";
  }

  if (lo.includes("descrip") || lo.includes("objeto")) {
    return "Describe con tus palabras lo que necesites incluir en esta sección.";
  }

  return `Cuéntame sobre "${label}". Escribe con tus propias palabras lo que quieras incluir en esta sección — yo me encargo de mejorar la redacción y el lenguaje jurídico.`;
}

function _appendChatMsgIA(role, text) {
  const msgs = document.getElementById("ia-chat-messages");
  if (!msgs) return;
  const wrap = document.createElement("div");
  wrap.className = "ia-chat-msg ia-chat-msg--" + role;
  const bubble = document.createElement("div");
  bubble.className = "ia-chat-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
}

/* Burbuja del usuario con botón "editar" para volver a esa pregunta */
function _appendChatMsgUserIA(text, placeholder) {
  const msgs = document.getElementById("ia-chat-messages");
  if (!msgs) return;
  const wrap = document.createElement("div");
  wrap.className = "ia-chat-msg ia-chat-msg--user";
  const phEsc = String(placeholder || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  wrap.innerHTML = `
    <div class="ia-chat-bubble-wrap">
      <button type="button" class="ia-chat-edit-btn"
        onclick="editarRespuestaChatIA('${phEsc}')"
        title="Editar esta respuesta" aria-label="Editar respuesta">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
        </svg>
        <span>Editar</span>
      </button>
      <div class="ia-chat-bubble"></div>
    </div>
  `;
  wrap.querySelector(".ia-chat-bubble").textContent = text;
  msgs.appendChild(wrap);
}

/* Render del chat dirigido por datos:
   recorre cada placeholder, muestra su Q + (A si ya está respondida).
   Al primer placeholder sin respuesta abre el input listo para escribir.
   Si todos están respondidos muestra el mensaje de cierre. */
function renderChatIA() {
  const msgs = document.getElementById("ia-chat-messages");
  const inp  = document.getElementById("ia-chat-input");
  const send = document.getElementById("ia-chat-send");
  if (!msgs) return;
  msgs.innerHTML = "";

  // Saludo
  _appendChatMsgIA("ai",
    "¡Hola! 👋 Soy tu asistente para redactar este documento. Te voy a hacer unas preguntas y, con tus respuestas, armaré el texto formal con lenguaje jurídico colombiano.\n\nPuedes editar cualquier respuesta más adelante con el botón ✎.");

  let activaEncontrada = false;

  for (let i = 0; i < placeholdersIA.length; i++) {
    const ph  = placeholdersIA[i];
    const ans = (camposIALlenados[ph] || "").trim();

    _appendChatMsgIA("ai", _chatPreguntaIA(ph));

    if (ans) {
      _appendChatMsgUserIA(ans, ph);
    } else {
      // Primer placeholder sin respuesta: pregunta activa
      activaEncontrada = true;
      if (inp) {
        inp.dataset.placeholder = ph;
        inp.disabled = false;
        inp.value = "";
        inp.style.height = "auto";
        inp.placeholder = "Escribe tu respuesta… (Shift+Enter para nueva línea)";
        setTimeout(() => { try { inp.focus(); } catch(_) {} }, 60);
      }
      if (send) send.disabled = false;
      break; // No mostrar las preguntas siguientes hasta responder ésta
    }
  }

  if (!activaEncontrada) {
    // Todas respondidas
    _appendChatMsgIA("ai",
      "¡Listo! 🎉 Tengo todo lo que necesito. Haz clic en \"Continuar al pago\" para que mejore tu redacción con lenguaje jurídico formal.\n\nSi quieres cambiar alguna respuesta, pulsa ✎ junto a ella.");
    if (inp) {
      delete inp.dataset.placeholder;
      inp.disabled = true;
      inp.value = "";
      inp.placeholder = "Conversación completada — usa ✎ para editar una respuesta";
    }
    if (send) send.disabled = true;
  }

  setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 30);
}

function enviarMensajeChatIA() {
  const inp = document.getElementById("ia-chat-input");
  if (!inp || inp.disabled) return;
  const txt = (inp.value || "").trim();
  if (!txt) { toast("Escribe una respuesta antes de enviarla.", "error"); return; }
  const ph = inp.dataset.placeholder;
  if (!ph) return;

  camposIALlenados[ph] = txt;
  // Si edita, invalidar la versión "mejorada" anterior
  if (camposIAMejorados[ph]) delete camposIAMejorados[ph];

  inp.value = "";
  inp.style.height = "auto";

  renderChatIA();

  if (typeof actualizarLivePreview === "function") {
    try { actualizarLivePreview(); } catch(_) {}
  }
  actualizarBotonChatIA();
}

/* Permite al usuario corregir una respuesta ya enviada del chat IA.
   Borra esa respuesta concreta (no las demás), re-pinta el chat y
   pre-rellena el input con el texto anterior para editarlo. */
function editarRespuestaChatIA(ph) {
  if (!ph || !placeholdersIA.includes(ph)) return;
  const valorPrevio = camposIALlenados[ph] || "";

  // Quitar la respuesta y la versión mejorada por la IA si existía
  delete camposIALlenados[ph];
  if (camposIAMejorados && camposIAMejorados[ph]) delete camposIAMejorados[ph];

  // Si la IA ya había procesado, hay que volver a procesar después de editar
  iaYaProcesada = false;

  // Quitar el preview de IA (si estaba mostrado tras procesar)
  const cont = document.getElementById("campos-ia-dinamicos");
  if (cont) {
    const prev = cont.querySelector(".ia-preview-resultado");
    if (prev) prev.remove();
  }

  // Restaurar el botón de continuar a su texto normal
  const btnNext = document.getElementById("btn-step-next");
  if (btnNext) {
    btnNext.textContent = "Continuar al pago →";
    btnNext.style.background = "";
  }

  renderChatIA();

  // Pre-rellenar el input con la respuesta anterior para que la pueda editar
  const inp = document.getElementById("ia-chat-input");
  if (inp) {
    inp.value = valorPrevio;
    inp.dataset.placeholder = ph;
    inp.disabled = false;
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight + 2, 180) + "px";
    setTimeout(() => {
      try {
        inp.focus();
        inp.setSelectionRange(valorPrevio.length, valorPrevio.length);
      } catch(_) {}
    }, 80);
  }
  const send = document.getElementById("ia-chat-send");
  if (send) send.disabled = false;

  actualizarBotonChatIA();
  if (typeof actualizarLivePreview === "function") {
    try { actualizarLivePreview(); } catch(_) {}
  }
  toast("Edita tu respuesta y vuelve a enviarla.", "");
}

function actualizarBotonChatIA() {
  const next = document.getElementById("btn-step-next");
  if (!next) return;
  // Si la IA ya procesó, dejar el botón habilitado (es el "He revisado…")
  if (iaYaProcesada) { next.disabled = false; next.style.opacity = ""; return; }
  const todos = placeholdersIA.length > 0 &&
                placeholdersIA.every(p => (camposIALlenados[p] || "").trim());
  next.disabled = !todos;
  next.style.opacity = todos ? "" : "0.5";
}

function humanizarPlaceholderIA(placeholder) {
  // Formato esperado: "ESPACIO PARA EL TEXTO DE LA IAn (LABEL)"
  // Extraer lo que está entre paréntesis, p.ej. "HECHOS" → "Hechos"
  const m = placeholder.match(/\(([^)]+)\)/);
  if (m) {
    const raw = m[1].trim();
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }
  // Fallback: quitar el prefijo y devolver el resto
  let label = placeholder
    .replace(/^ESPACIO PARA EL TEXTO DE LA IA\d*\s*/i, "")
    .trim();
  if (!label) return "Texto (IA)";
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

function saveCamposIAActuales() {
  // Si hay un mensaje pendiente en el chat (escrito pero no enviado), guardarlo
  const chatInp = document.getElementById("ia-chat-input");
  if (chatInp && chatInp.dataset.placeholder && (chatInp.value || "").trim()) {
    camposIALlenados[chatInp.dataset.placeholder] = chatInp.value.trim();
  }
  // Modo legacy / admin (textareas)
  document.querySelectorAll(".campo-ia-input").forEach(inp => {
    camposIALlenados[inp.dataset.placeholder] = inp.value.trim();
  });
}

function validateCamposIA() {
  // Si la UI es el chat, validamos contra el modelo de datos
  if (document.getElementById("ia-chat")) {
    return placeholdersIA.length > 0 &&
           placeholdersIA.every(p => (camposIALlenados[p] || "").trim());
  }
  // Modo legacy / admin (textareas)
  let valid = true;
  document.querySelectorAll(".campo-ia-input").forEach(inp => {
    if (!inp.value.trim()) { inp.style.borderColor = "var(--danger)"; valid = false; }
    else inp.style.borderColor = "";
  });
  return valid;
}

/* Llama a OpenAI con todos los textos en una sola petición */
/* ──────────────────────────────────────────────────────────────────
   DETECCIÓN DE TIPO DE DOCUMENTO
   ──────────────────────────────────────────────────────────────────
   Identifica si la minuta es una demanda, derecho de petición, tutela,
   contrato, etc., para que la IA y el chat usen los términos correctos
   ("demandante", "peticionario", "accionante", etc.) en lugar de asumir
   siempre que es una demanda. */
const TIPOS_DOC = {
  demanda: {
    nombre: "demanda judicial",
    rolUsuario: "demandante",
    rolContraparte: "demandado/a",
    destinatario: "el juez competente",
    instruccionAI:
      "Es una DEMANDA JUDICIAL. Refiérete al usuario como \"el/la demandante\" o \"el/la suscrito/a demandante\". " +
      "A la otra parte como \"el/la demandado/a\". Las pretensiones se dirigen al juez competente. " +
      "PROHIBIDO usar \"peticionario\" o \"accionante\" en este contexto."
  },
  peticion: {
    nombre: "derecho de petición",
    rolUsuario: "peticionario",
    rolContraparte: "la entidad destinataria",
    destinatario: "la entidad pública o privada destinataria",
    instruccionAI:
      "Es un DERECHO DE PETICIÓN (artículo 23 de la Constitución Política y Ley 1755 de 2015). " +
      "Refiérete al usuario como \"el/la peticionario/a\" o \"el/la suscrito/a peticionario/a\". " +
      "PROHIBIDO usar \"demandante\" o \"accionante\". " +
      "Las solicitudes se dirigen formalmente a la entidad destinataria, no a un juez. " +
      "Usa fórmulas como \"De manera respetuosa, solicito...\", \"Conforme al artículo 23 de la C.P.\" o \"Atentamente solicito...\"."
  },
  tutela: {
    nombre: "acción de tutela",
    rolUsuario: "accionante",
    rolContraparte: "la entidad accionada",
    destinatario: "el juez constitucional",
    instruccionAI:
      "Es una ACCIÓN DE TUTELA (artículo 86 de la Constitución Política y Decreto 2591 de 1991). " +
      "Refiérete al usuario como \"el/la accionante\" o \"el/la suscrito/a accionante\". " +
      "A la contraparte como \"la entidad accionada\" o \"el/la accionado/a\". " +
      "PROHIBIDO usar \"demandante\" o \"peticionario\". " +
      "Las pretensiones son de protección constitucional (\"se proteja el derecho fundamental a...\")."
  },
  queja: {
    nombre: "queja o reclamación",
    rolUsuario: "quejoso",
    rolContraparte: "la entidad o persona contra la que se interpone la queja",
    destinatario: "la entidad u organismo competente",
    instruccionAI:
      "Es una QUEJA o RECLAMACIÓN. Refiérete al usuario como \"el/la quejoso/a\" o \"el/la reclamante\". " +
      "PROHIBIDO usar \"demandante\". Usa lenguaje administrativo formal."
  },
  denuncia: {
    nombre: "denuncia",
    rolUsuario: "denunciante",
    rolContraparte: "el denunciado",
    destinatario: "la autoridad competente (Fiscalía, Policía, etc.)",
    instruccionAI:
      "Es una DENUNCIA. Refiérete al usuario como \"el/la denunciante\". " +
      "A la persona o entidad denunciada como \"el/la denunciado/a\". " +
      "PROHIBIDO usar \"demandante\"."
  },
  recurso: {
    nombre: "recurso administrativo o procesal",
    rolUsuario: "recurrente",
    rolContraparte: "la autoridad o parte contraria",
    destinatario: "la autoridad que conoce el recurso",
    instruccionAI:
      "Es un RECURSO (apelación, reposición, súplica, queja, etc.). " +
      "Refiérete al usuario como \"el/la recurrente\" o \"el/la suscrito/a recurrente\". " +
      "Las pretensiones son las propias del recurso (revocar, modificar, confirmar, etc.)."
  },
  contrato: {
    nombre: "contrato",
    rolUsuario: "una de las partes contratantes",
    rolContraparte: "la otra parte contratante",
    destinatario: "(no aplica — es un acuerdo entre partes)",
    instruccionAI:
      "Es un CONTRATO entre partes privadas. " +
      "PROHIBIDO usar lenguaje de demanda (no hay \"demandante\", \"juez\" ni \"pretensiones\"). " +
      "Usa lenguaje contractual: \"las partes acuerdan\", \"se obliga a\", \"declara y garantiza\", \"en virtud del presente contrato\", etc."
  },
  poder: {
    nombre: "poder o mandato",
    rolUsuario: "poderdante",
    rolContraparte: "el apoderado o mandatario",
    destinatario: "(no aplica)",
    instruccionAI:
      "Es un PODER o MANDATO. Refiérete al usuario como \"el/la poderdante\" y a quien recibe el poder como \"el/la apoderado/a\" o \"mandatario/a\". " +
      "Usa lenguaje formal de otorgamiento (\"confiero\", \"otorgo\", \"faculto\")."
  },
  desistimiento: {
    nombre: "desistimiento o renuncia",
    rolUsuario: "el suscrito",
    rolContraparte: "(no aplica)",
    destinatario: "el juez o autoridad que conoce el proceso",
    instruccionAI:
      "Es un DESISTIMIENTO o RENUNCIA. Refiérete al usuario como \"el/la suscrito/a\" (o por el rol que tenga en el proceso original: demandante, accionante, etc., si se infiere del contexto). " +
      "Usa fórmulas como \"manifiesto mi voluntad de desistir\", \"renuncio formalmente a...\"."
  },
  generico: {
    nombre: "documento legal",
    rolUsuario: "el suscrito",
    rolContraparte: "la contraparte",
    destinatario: "el destinatario",
    instruccionAI:
      "Documento legal de tipo genérico. Usa lenguaje jurídico formal y NEUTRAL. " +
      "Refiérete al usuario como \"el/la suscrito/a\" o \"el/la solicitante\". " +
      "PROHIBIDO asumir que es una demanda — no uses \"demandante\" salvo que el texto del usuario lo diga explícitamente."
  }
};

function detectarTipoDocumento(minuta) {
  const fallback = { tipo: "generico", ...TIPOS_DOC.generico };
  if (!minuta) return fallback;

  // 1) Anulación manual del admin
  const manual = (minuta.tipoDocumento || "").trim().toLowerCase();
  if (manual && TIPOS_DOC[manual]) return { tipo: manual, ...TIPOS_DOC[manual] };

  // 2) Auto-detección por nombre + categoría + descripción
  const txt = `${minuta.nombre || ""} ${minuta.categoria || ""} ${minuta.descripcion || ""}`.toLowerCase();

  if (/\btutela\b|acci[oó]n de tutela/.test(txt))                                    return { tipo: "tutela",        ...TIPOS_DOC.tutela };
  if (/derecho de petici[oó]n|\bpetici[oó]n\b/.test(txt))                            return { tipo: "peticion",      ...TIPOS_DOC.peticion };
  if (/\bdenuncia\b/.test(txt))                                                      return { tipo: "denuncia",      ...TIPOS_DOC.denuncia };
  if (/\bqueja\b|reclamaci[oó]n|\breclamo\b/.test(txt))                              return { tipo: "queja",         ...TIPOS_DOC.queja };
  if (/recurso de (apelaci[oó]n|reposici[oó]n|s[uú]plica|queja|alzada)|\brecurso\b/.test(txt))
                                                                                      return { tipo: "recurso",       ...TIPOS_DOC.recurso };
  if (/desistimiento|renuncia/.test(txt))                                            return { tipo: "desistimiento", ...TIPOS_DOC.desistimiento };
  if (/\bpoder\b|mandato/.test(txt))                                                 return { tipo: "poder",         ...TIPOS_DOC.poder };
  if (/\bdemanda\b/.test(txt))                                                       return { tipo: "demanda",       ...TIPOS_DOC.demanda };
  if (/\bcontrato\b|arrendamiento|compraventa|prestaci[oó]n de servicios|\blaboral\b|sociedad|cesi[oó]n/.test(txt))
                                                                                      return { tipo: "contrato",      ...TIPOS_DOC.contrato };

  return fallback;
}

async function mejorarTextosConIA() {
  const textos = Object.entries(camposIALlenados)
    .filter(([,v]) => v.trim())
    .map(([clave, texto]) => ({ clave, texto }));

  if (!textos.length) return;

  // Sin API Key → usar textos originales sin bloquear (no cuenta como uso de IA)
  if (!geminiConfig.apiKey) {
    textos.forEach(t => { camposIAMejorados[t.clave] = t.texto; });
    toast("IA no configurada. Se usará el texto original tal como lo escribiste.", "");
    return;
  }

  // Verificar límite de usos de IA
  const limiteIA = iaLimitCheck();
  if (limiteIA.bloqueado) {
    toast(iaLimitMensaje(limiteIA.msRestantes), "error");
    textos.forEach(t => { camposIAMejorados[t.clave] = t.texto; });
    return;
  }

  const overlay = document.getElementById("processing-overlay");
  const msg     = document.getElementById("processing-msg");
  overlay.classList.add("open");
  msg.textContent = "La IA está mejorando la redacción... esto puede tomar unos segundos.";

  /* Un único prompt con todos los campos numerados → respuesta JSON */
  const bloques = textos.map((t, i) => {
    const label = humanizarPlaceholderIA(t.clave);
    return `[CAMPO_${i+1}] — ${label.toUpperCase()}\n${t.texto}`;
  }).join("\n\n");

  // Detectar el tipo de documento para personalizar el rol del usuario y la
  // contraparte en el lenguaje jurídico que generará la IA.
  const tipoInfo = detectarTipoDocumento(currentMinuta);
  const nombreDoc = (currentMinuta && currentMinuta.nombre) ? currentMinuta.nombre : "documento legal";
  const catDoc    = (currentMinuta && currentMinuta.categoria) ? currentMinuta.categoria : "no especificada";
  const ctxExtra  = (currentMinuta && currentMinuta.contextoIA) ? String(currentMinuta.contextoIA).trim() : "";

  const systemPrompt =
    `Eres un abogado colombiano experto en redacción jurídica (demandas, derechos de petición, tutelas, contratos, recursos y demás documentos legales). ` +
    `Recibirás uno o más textos de distintas secciones de un documento legal, identificados con [CAMPO_N] y el nombre de la sección. ` +
    `\n\n=== CONTEXTO DEL DOCUMENTO ===\n` +
    `Documento que se está redactando: "${nombreDoc}" (categoría: ${catDoc}). ` +
    `Tipo identificado: ${tipoInfo.nombre.toUpperCase()}. ` +
    `${tipoInfo.instruccionAI} ` +
    `Cuando necesites referirte al usuario, usa SIEMPRE: "${tipoInfo.rolUsuario}". ` +
    `Cuando necesites referirte a la otra parte, usa: "${tipoInfo.rolContraparte}". ` +
    `Las solicitudes/pretensiones se dirigen a: ${tipoInfo.destinatario}. ` +
    `Si el usuario en su texto crudo usa una palabra incorrecta para su rol (por ejemplo escribe "el demandante" en un derecho de petición), CORRÍGELO al rol que corresponda según el tipo de documento. ` +
    (ctxExtra
      ? `\n\n=== CONTEXTO ADICIONAL ESPECÍFICO DE ESTA MINUTA (instrucciones del administrador) ===\n${ctxExtra}\nIntegra estas indicaciones en tu redacción siempre que no contradigan las reglas anteriores ni te obliguen a inventar datos no proporcionados por el usuario. `
      : ``) +
    `\n\n=== REGLAS GENERALES OBLIGATORIAS ===\n` +
    `1) DEBES reescribir el texto con lenguaje jurídico formal colombiano. Corrige ortografía, tildes, puntuación y gramática. ` +
    `2) FORMATO DE NUMERACIÓN OBLIGATORIO: Cuando uses PRIMERO., SEGUNDO., TERCERO., etc., el número y su contenido van SIEMPRE en la misma línea, juntos. ` +
    `CORRECTO: "PRIMERO. ${tipoInfo.rolUsuario.charAt(0).toUpperCase() + tipoInfo.rolUsuario.slice(1)} se encontraba en el lugar...\\nSEGUNDO. Al acercarse a la persona..." ` +
    `INCORRECTO: "PRIMERO.\\n${tipoInfo.rolUsuario} se encontraba..." — NUNCA pongas el número solo en una línea y el texto abajo. ` +
    `3) Cada hecho o pretensión numerada va en su propia línea (separada con \\n), pero el número y el texto van JUNTOS en esa misma línea. ` +
    `4) PROHIBICIÓN ABSOLUTA DE INVENTAR: No agregues ningún dato, fecha, nombre, dirección, ciudad, número o detalle que NO esté en el texto original del usuario. Solo mejora la redacción y el lenguaje con la información ya proporcionada. ` +
    `\n\n=== INSTRUCCIONES POR SECCIÓN ===\n` +
    `Para HECHOS: redacta cada hecho de forma narrativa, cronológica y formal. CADA hecho DEBE ser un párrafo completo y sustancial de al menos 3 oraciones: ` +
    `(a) enuncia el hecho central con todos los detalles disponibles, ` +
    `(b) describe el contexto o las circunstancias relevantes, ` +
    `(c) señala la consecuencia o relevancia jurídica. ` +
    `Usa vocabulario propio del derecho colombiano (v.gr., "el/la suscrito/a ${tipoInfo.rolUsuario}", "en virtud de lo anterior", "de conformidad con", etc.). ` +
    `Formato: "PRIMERO. [párrafo extenso del hecho]\\nSEGUNDO. [párrafo extenso del hecho]\\n..." ` +
    `Para PRETENSIONES / SOLICITUDES / PETICIONES: redacta como puntos numerados formales dirigidos a ${tipoInfo.destinatario}, cada uno claro, conciso y con fundamento jurídico implícito apropiado al tipo de documento. ` +
    `Formato: "PRIMERO. [pretensión / solicitud]\\nSEGUNDO. [pretensión / solicitud]\\n..." ` +
    `Para FUNDAMENTOS DE DERECHO: cita normativa colombiana relevante al tipo de documento sin inventar artículos específicos que no aparezcan en el texto original. ` +
    `Para cualquier otra sección: mejora ortografía, puntuación y redacción formal sin agregar ni quitar información. ` +
    `\n\n=== FORMATO DE RESPUESTA ===\n` +
    `Responde ÚNICAMENTE con JSON puro: {"CAMPO_1":"texto mejorado con \\n para saltos de línea","CAMPO_2":"texto mejorado",...}. ` +
    `Sin explicaciones, sin markdown, sin bloques de código.`;

  try {
    const resp = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${geminiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: bloques }
        ],
        temperature: 0.2,
        max_tokens: 4096,
        response_format: { type: "json_object" }
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const errMsg = err?.error?.message || resp.statusText || "Error desconocido";
      throw new Error(errMsg);
    }

    const data = await resp.json();
    const raw  = data?.choices?.[0]?.message?.content?.trim() || "";

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch(_) {
      // Si no parsea, intentar limpiar bloques markdown
      const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      try { parsed = JSON.parse(clean); } catch(__) {}
    }

    camposIAMejorados = {};
    textos.forEach((t, i) => {
      const key = `CAMPO_${i+1}`;
      camposIAMejorados[t.clave] = (parsed && parsed[key]) ? String(parsed[key]).trim() : t.texto;
    });

    // Mostrar preview del resultado de la IA en la UI
    mostrarPreviewIA();
    // Contabilizar el uso de IA (y bloquear si se alcanzó el límite)
    iaLimitIncrement();

  } catch(e) {
    const detalle = e instanceof Error ? e.message : String(e);
    console.error("[Groq] Error al mejorar texto:", detalle);
    let msgError = "La IA no pudo procesar el texto. Se usará el texto original.";
    if (detalle.includes("invalid_api_key") || detalle.includes("401") || detalle.includes("Authentication")) {
      msgError = "La clave de Groq no es válida. Verifica la clave en Admin → Configurar IA.";
    } else if (detalle.includes("429") || detalle.includes("rate_limit") || detalle.includes("quota")) {
      msgError = "Se alcanzó el límite gratuito de Groq. Espera un momento e intenta de nuevo.";
    } else if (detalle.includes("Failed to fetch") || detalle.includes("NetworkError")) {
      msgError = "Error de red al conectar con Groq. Verifica tu conexión.";
    } else if (detalle) {
      msgError = `Error de IA: ${detalle.substring(0, 120)}. Se usará el texto original.`;
    }
    toast(msgError, "error");
    textos.forEach(t => { camposIAMejorados[t.clave] = t.texto; });
  } finally {
    overlay.classList.remove("open");
  }
}

/* ── PREVIEW DE TEXTOS MEJORADOS POR IA (con regeneración individual) ── */
function mostrarPreviewIA() {
  const cont = document.getElementById("campos-ia-dinamicos");
  if (!cont) return;

  const entradas = Object.entries(camposIAMejorados);
  if (!entradas.length) return;

  iaYaProcesada = true;

  const btnNext = document.getElementById("btn-step-next");
  if (btnNext) {
    btnNext.textContent = "He revisado — Continuar al pago →";
    btnNext.style.background = "var(--success)";
  }

  let existente = cont.querySelector(".ia-preview-resultado");
  if (existente) existente.remove();

  const preview = document.createElement("div");
  preview.className = "ia-preview-resultado";
  preview.style.cssText = "margin-top:20px;border-top:2px solid rgba(37,99,168,0.2);padding-top:16px;";

  const camposHtml = entradas.map(([clave, textoMejorado]) => {
    const label = humanizarPlaceholderIA(clave);
    const claveEsc = esc(clave).replace(/'/g, "\\'");
    return `<div class="ia-campo-resultado" data-clave="${esc(clave)}" style="margin-bottom:16px;border:1px solid var(--border);border-radius:10px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:rgba(26,58,92,0.04);border-bottom:1px solid var(--border);">
        <span style="font-size:0.82rem;font-weight:700;color:var(--primary);">${esc(label)}</span>
        <button onclick="regenerarCampoIA('${claveEsc}')" data-regen="${esc(clave)}" style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;background:#fff;border:1.5px solid rgba(37,99,168,0.3);border-radius:7px;color:var(--primary-light);font-size:0.78rem;font-weight:700;cursor:pointer;white-space:nowrap;">
          ↻ Regenerar este campo
        </button>
      </div>
      <div class="ia-campo-texto" style="padding:12px 14px;font-size:0.87rem;color:var(--text);line-height:1.65;white-space:pre-wrap;background:rgba(30,126,52,0.03);">${esc(textoMejorado)}</div>
    </div>`;
  }).join("");

  preview.innerHTML = `
    <p style="font-size:0.88rem;font-weight:700;color:var(--success);margin-bottom:14px;">
      ✅ La IA mejoró tu redacción. Así quedará en el documento:
    </p>
    ${camposHtml}
    <p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;font-style:italic;">
      Cada campo tiene su propio botón para regenerar solo ese texto con una redacción diferente.
    </p>
  `;
  cont.appendChild(preview);
  preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  actualizarLivePreview();
}

/* ── REGENERAR UN CAMPO INDIVIDUAL CON IA ── */
async function regenerarCampoIA(clave) {
  // Verificar límite de usos antes de cualquier acción
  const limiteRegen = iaLimitCheck();
  if (limiteRegen.bloqueado) {
    toast(iaLimitMensaje(limiteRegen.msRestantes), "error"); return;
  }
  if (!geminiConfig.apiKey) {
    toast("IA no configurada. Configura tu clave de Groq en Admin → Configuración IA.", "error"); return;
  }
  saveCamposIAActuales();
  const textoOriginal = camposIALlenados[clave];
  if (!textoOriginal || !textoOriginal.trim()) {
    toast("El campo está vacío. Escribe algo primero.", "error"); return;
  }

  const label = humanizarPlaceholderIA(clave);

  const btnRegen = document.querySelector(`[data-regen="${CSS.escape(clave)}"]`);
  if (btnRegen) { btnRegen.disabled = true; btnRegen.textContent = "Redactando…"; }

  const variacion = Math.floor(Math.random() * 9000) + 1000;
  const tipoInfoR = detectarTipoDocumento(currentMinuta);
  const ctxExtraR = (currentMinuta && currentMinuta.contextoIA) ? String(currentMinuta.contextoIA).trim() : "";
  const systemPrompt =
    `Eres un abogado colombiano experto en redacción jurídica. ` +
    `Estás regenerando un campo de un documento del tipo: ${tipoInfoR.nombre.toUpperCase()}. ` +
    `${tipoInfoR.instruccionAI} Refiérete al usuario como "${tipoInfoR.rolUsuario}" y a la otra parte como "${tipoInfoR.rolContraparte}". Las solicitudes se dirigen a ${tipoInfoR.destinatario}. ` +
    (ctxExtraR
      ? `\nCONTEXTO ADICIONAL ESPECÍFICO: ${ctxExtraR}\n`
      : ``) +
    `VARIACIÓN #${variacion}: Debes producir una redacción diferente a versiones anteriores variando ÚNICAMENTE el vocabulario jurídico, la estructura gramatical y el estilo formal — NUNCA agregando información nueva. ` +
    `REGLA ABSOLUTA E INNEGOCIABLE — PROHIBICIÓN DE INVENTAR: Está TERMINANTEMENTE PROHIBIDO agregar cualquier dato, hecho, fecha, nombre, dirección, ciudad, número, característica o detalle que NO esté explícitamente en el texto original del usuario. ` +
    `Si el usuario no mencionó una fecha, NO escribas ninguna fecha. Si no mencionó una dirección, NO escribas ninguna dirección. Si no mencionó una ciudad, NO escribas ninguna ciudad. Solo puedes usar exactamente la información que el usuario proporcionó. ` +
    `REGLAS DE FORMATO: 1) Reescribe con lenguaje jurídico formal colombiano. Corrige ortografía, tildes y gramática únicamente. ` +
    `2) FORMATO DE NUMERACIÓN: Cuando uses PRIMERO., SEGUNDO., TERCERO., etc., el número y su texto van SIEMPRE en la misma línea. ` +
    `CORRECTO: "PRIMERO. [texto]\\nSEGUNDO. [texto]" — INCORRECTO: "PRIMERO.\\n[texto]". ` +
    `Para HECHOS: narrativa cronológica y formal, formato "PRIMERO. [hecho]\\nSEGUNDO. [hecho]\\n...". ` +
    `Para PRETENSIONES: pretensiones numeradas formales, formato "PRIMERO. [pretensión]\\nSEGUNDO. [pretensión]\\n...". ` +
    `Responde ÚNICAMENTE con JSON puro: {"resultado":"texto mejorado con \\n para saltos de línea"}. Sin markdown.`;

  try {
    const resp = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${geminiConfig.apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: `[${label.toUpperCase()}]\n${textoOriginal}` }
        ],
        temperature: 0.85,
        max_tokens: 2048,
        response_format: { type: "json_object" }
      })
    });

    if (!resp.ok) throw new Error((await resp.json().catch(()=>({}))).error?.message || resp.statusText);
    const data = await resp.json();
    const raw  = data?.choices?.[0]?.message?.content?.trim() || "";
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch(_) {
      const clean = raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
      try { parsed = JSON.parse(clean); } catch(__) {}
    }
    const nuevoTexto = parsed?.resultado ? String(parsed.resultado).trim() : textoOriginal;
    camposIAMejorados[clave] = nuevoTexto;
    actualizarLivePreview();

    const card = document.querySelector(`.ia-campo-resultado[data-clave="${CSS.escape(clave)}"]`);
    if (card) {
      card.querySelector(".ia-campo-texto").textContent = nuevoTexto;
      card.style.borderColor = "rgba(37,99,168,0.4)";
      setTimeout(() => { card.style.borderColor = "var(--border)"; }, 1200);
    }
    // Contabilizar este uso de IA
    const bloqueadoAhora = iaLimitIncrement();
    const msgExito = bloqueadoAhora
      ? `${label} regenerado. ⚠️ Límite de ${IA_MAX_USOS} usos alcanzado — IA bloqueada por 1 hora.`
      : `${label} regenerado con éxito.`;
    toast(msgExito, bloqueadoAhora ? "error" : "ok");
  } catch(e) {
    toast("Error al regenerar: " + (e.message||String(e)).substring(0,80), "error");
  } finally {
    if (btnRegen) { btnRegen.disabled = false; btnRegen.textContent = "↻ Regenerar este campo"; }
  }
}

/* ── REGENERAR TEXTOS CON IA ── */
async function regenerarConIA() {
  // Limpiar estado anterior
  iaYaProcesada = false;
  camposIAMejorados = {};

  // Restaurar botón a su estado normal
  const btnNext = document.getElementById("btn-step-next");
  if (btnNext) {
    btnNext.textContent = "Continuar al pago →";
    btnNext.style.background = "";
    btnNext.disabled = true;
  }

  // Quitar el preview anterior
  const cont = document.getElementById("campos-ia-dinamicos");
  const prevExistente = cont ? cont.querySelector(".ia-preview-resultado") : null;
  if (prevExistente) prevExistente.remove();

  toast("Pidiendo a la IA que redacte de nuevo…", "");

  // Guardar por si el usuario editó algún campo antes de regenerar
  saveCamposIAActuales();

  // Volver a procesar con IA (usa los mismos textos del usuario)
  await mejorarTextosConIA();

  if (btnNext) btnNext.disabled = false;
}

/* ── NAVEGACIÓN DE PASOS ── */
async function stepNext() {
  const totalSteps = getTotalSteps();
  const panelId    = getStepPanelId(currentStep);

  if (panelId === 2) {
    // Campos normales
    if (!validateCamposActuales()) { toast("Completa todos los campos.", "error"); return; }
    saveCamposActuales();
    renderStep(currentStep + 1);
  } else if (panelId === "clausulas") {
    saveClausulasActuales();
    const resClausulas = validateClausulas();
    if (!resClausulas.ok) {
      marcarCamposExtraFaltantes();
      toast(resClausulas.razon, "error");
      return;
    }
    renderStep(currentStep + 1);
  } else if (panelId === 3) {
    // Campos IA — flujo de dos clics: primero procesa y muestra preview, luego avanza
    if (!iaYaProcesada) {
      if (!validateCamposIA()) { toast("Completa todos los campos de IA.", "error"); return; }
      saveCamposIAActuales();
      await mejorarTextosConIA();
      if (iaYaProcesada) return;
      renderStep(currentStep + 1);
      return;
    }
    // Segunda vez: usuario revisó el preview y confirmó, avanzar al pago
    iaYaProcesada = false;
    renderStep(currentStep + 1);
  } else if (panelId === 4) {
    const precio = Number(currentMinuta ? currentMinuta.precio || 0 : 0);
    if (precio === 0) { obtenerGratis(); } else { iniciarPagoWompi(); }
  }
}

function stepBack() {
  const panelId = getStepPanelId(currentStep);
  if (panelId === 2) { saveCamposActuales(); camposCurrentPage = 1; }
  if (panelId === "clausulas") { saveClausulasActuales(); }
  if (panelId === 3) { saveCamposIAActuales(); iaYaProcesada = false; }
  if (currentStep > 1) renderStep(currentStep - 1);
}

/* ── PAGO CON WOMPI ── */
async function cargarWompiConfig() {
  if (!db) return;
  try {
    const snap = await db.collection("config").doc("wompi").get();
    if (snap.exists) wompiConfig = snap.data();
  } catch(_) {}
}

function renderPagoStep() {
  const checkoutSection    = document.getElementById("wompi-checkout-section");
  const notConfigured      = document.getElementById("wompi-not-configured");
  const pendingSection     = document.getElementById("wompi-pending-section");
  const modoPruebaSection  = document.getElementById("modo-prueba-section");
  const gratisSection      = document.getElementById("gratis-section");
  const loginRequired      = document.getElementById("pago-login-required");
  const payTotal           = document.getElementById("pay-total-monto");

  pendingSection.style.display = "none";

  const precio = Number(currentMinuta ? currentMinuta.precio || 0 : 0);

  // Actualizar total visible
  if (payTotal) payTotal.textContent = precio === 0 ? "Gratis" : `$${precio.toLocaleString("es-CO")} COP`;

  // ── Si NO hay sesión: mostrar el aviso de login y ocultar todo lo demás ──
  if (!currentUser) {
    if (loginRequired)     loginRequired.style.display     = "block";
    if (checkoutSection)   checkoutSection.style.display   = "none";
    if (notConfigured)     notConfigured.style.display     = "none";
    if (modoPruebaSection) modoPruebaSection.style.display = "none";
    if (gratisSection)     gratisSection.style.display     = "none";
    return;
  }

  // Hay sesión: ocultar el aviso de login
  if (loginRequired) loginRequired.style.display = "none";

  // Si el precio es 0: mostrar sección gratuita y ocultar todo lo demás
  if (precio === 0) {
    checkoutSection.style.display  = "none";
    notConfigured.style.display    = "none";
    modoPruebaSection.style.display = "none";
    gratisSection.style.display    = "block";
    return;
  }

  gratisSection.style.display = "none";

  if (modoPrueba) {
    checkoutSection.style.display   = "none";
    notConfigured.style.display     = "none";
    modoPruebaSection.style.display = "block";
  } else {
    modoPruebaSection.style.display = "none";
    if (wompiConfig.publicKey) {
      checkoutSection.style.display = "block"; notConfigured.style.display = "none";
    } else {
      checkoutSection.style.display = "none"; notConfigured.style.display = "block";
    }
  }
}

async function obtenerGratis() {
  if (!currentUser) { pedirInicioSesion(); return; }
  const btn = document.querySelector("#gratis-section .btn");
  if (btn) { btn.disabled = true; btn.textContent = "Procesando..."; }
  try {
    const ref = generarReferenciaUnica();
    await registrarVenta(ref, "gratis", "gratis");
    pagoExitoso = true;
    renderStep(getTotalSteps());
  } catch(err) {
    toast("Error al obtener el documento: " + (err.message || err), "error");
    if (btn) { btn.disabled = false; btn.textContent = "Obtener documento gratis"; }
  }
}

/* ── MODO PRUEBA ── */
function actualizarEstadoModoPrueba() {
  const el = document.getElementById("modo-prueba-estado");
  if (!el) return;
  if (modoPrueba) {
    el.textContent = "✅ Activado";
    el.style.color = "var(--success)";
    el.style.fontWeight = "700";
  } else {
    el.textContent = "Desactivado";
    el.style.color = "var(--text-muted)";
    el.style.fontWeight = "";
  }
}

function activarModoPrueba() {
  modoPrueba = true;
  localStorage.setItem("modoPrueba", "1");
  actualizarEstadoModoPrueba();
  toast("Modo prueba activado. Los pagos serán simulados.", "ok");
}

function desactivarModoPrueba() {
  modoPrueba = false;
  localStorage.removeItem("modoPrueba");
  actualizarEstadoModoPrueba();
  toast("Modo prueba desactivado. Los pagos son reales.");
}

/* ─────────────────────────────────────────────────────
   ADMIN TABS
───────────────────────────────────────────────────── */
function cambiarTabAdmin(tabId, btn) {
  document.querySelectorAll(".admin-tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(tabId).classList.add("active");
  if (btn) btn.classList.add("active");
  if (tabId === "tab-categorias") {
    loadAdminCategorias();
    renderAdminData();
  }
  if (tabId === "tab-historial") renderAdminData();
}

/* ─────────────────────────────────────────────────────
   PREVISUALIZACIÓN TEMPORAL (10 SEGUNDOS)
   Límite: máx 4 vistas por minuta; bloqueada 1 hora después
───────────────────────────────────────────────────── */
let _previewTimer = null;
let _previewMinutaId = null;
const PREVIEW_MAX_VISTAS = 4;
const PREVIEW_BLOQUEO_MS = 60 * 60 * 1000; // 1 hora en ms

function obtenerRegistroVistas(id) {
  try {
    const raw = localStorage.getItem("preview_vistas_" + id);
    if (!raw) return { count: 0, bloqueadoHasta: 0 };
    return JSON.parse(raw);
  } catch(_) { return { count: 0, bloqueadoHasta: 0 }; }
}

function guardarRegistroVistas(id, registro) {
  try { localStorage.setItem("preview_vistas_" + id, JSON.stringify(registro)); } catch(_) {}
}

function verificarLimiteVistas(id) {
  const reg = obtenerRegistroVistas(id);
  const ahora = Date.now();
  // Si hay un bloqueo activo
  if (reg.bloqueadoHasta && ahora < reg.bloqueadoHasta) {
    const minutosRestantes = Math.ceil((reg.bloqueadoHasta - ahora) / 60000);
    return { bloqueado: true, minutosRestantes };
  }
  // Si el bloqueo ya expiró, reiniciar contador
  if (reg.bloqueadoHasta && ahora >= reg.bloqueadoHasta) {
    guardarRegistroVistas(id, { count: 0, bloqueadoHasta: 0 });
    return { bloqueado: false };
  }
  return { bloqueado: false };
}

function registrarVistaPreview(id) {
  const reg = obtenerRegistroVistas(id);
  const nuevoCount = (reg.count || 0) + 1;
  if (nuevoCount >= PREVIEW_MAX_VISTAS) {
    guardarRegistroVistas(id, { count: nuevoCount, bloqueadoHasta: Date.now() + PREVIEW_BLOQUEO_MS });
  } else {
    guardarRegistroVistas(id, { count: nuevoCount, bloqueadoHasta: 0 });
  }
  return nuevoCount;
}

function mostrarModalBloqueado(nombreMinuta, minutosRestantes) {
  const overlay  = document.getElementById("preview-timed-overlay");
  const content  = document.getElementById("preview-timed-content");
  const titulo   = document.getElementById("preview-timed-titulo");
  const bar      = document.getElementById("countdown-bar");
  const timerTxt = document.getElementById("countdown-text");
  const btnAdq   = document.getElementById("preview-timed-adquirir");
  const footer   = overlay.querySelector(".preview-timed-footer");

  titulo.textContent = "Vista previa no disponible";
  bar.style.width = "0%";
  timerTxt.innerHTML = "";
  if (footer) footer.style.display = "none";
  content.innerHTML = `
    <div style="text-align:center;padding:30px 20px;">
      <div style="font-size:3rem;margin-bottom:16px;">🔒</div>
      <h4 style="font-size:1.1rem;color:var(--primary);margin-bottom:12px;">Has alcanzado el límite de vistas previas</h4>
      <p style="font-size:0.9rem;color:var(--text-muted);line-height:1.6;margin-bottom:20px;">
        Has visto esta minuta demasiadas veces. Podrás volver a previsualizar en aproximadamente
        <strong>${minutosRestantes} minuto${minutosRestantes !== 1 ? "s" : ""}</strong>.
      </p>
      <p style="font-size:0.9rem;color:var(--text);font-weight:600;margin-bottom:20px;">
        ¿Te interesa este documento? Adquiérela para acceder al documento completo y personalizado sin restricciones.
      </p>
      <button class="btn btn-primary" onclick="cerrarPreviewBloqueado('${_previewMinutaId}')">
        Adquirir minuta
      </button>
    </div>`;
  overlay.classList.add("open");
}

function cerrarPreviewBloqueado(id) {
  const overlay = document.getElementById("preview-timed-overlay");
  const footer  = overlay.querySelector(".preview-timed-footer");
  overlay.classList.remove("open");
  if (footer) footer.style.display = "";
  if (id) abrirMinuta(id);
}

async function previsualizarMinuta(id, evt) {
  if (evt) evt.stopPropagation();
  _previewMinutaId = id;

  // Verificar si el usuario está bloqueado para esta minuta
  const limiteCheck = verificarLimiteVistas(id);
  if (limiteCheck.bloqueado) {
    const minuta = minutasData.find(m => m.id === id);
    mostrarModalBloqueado(minuta ? minuta.nombre : "", limiteCheck.minutosRestantes);
    return;
  }

  // Registrar esta vista
  registrarVistaPreview(id);

  const overlay  = document.getElementById("preview-timed-overlay");
  const content  = document.getElementById("preview-timed-content");
  const titulo   = document.getElementById("preview-timed-titulo");
  const bar      = document.getElementById("countdown-bar");
  const timerTxt = document.getElementById("countdown-text");
  const btnAdq   = document.getElementById("preview-timed-adquirir");

  const minuta = minutasData.find(m => m.id === id);
  if (!minuta) { toast("Minuta no encontrada.", "error"); return; }

  _previewMinutaId = id;
  titulo.textContent = minuta.nombre || "Vista previa";
  content.innerHTML = '<div class="loading-spinner"></div>';
  btnAdq.onclick = () => { cerrarPreviewTimed(); abrirMinuta(id); };
  overlay.classList.add("open");

  let html = "";

  // Fuente 1: URL de previsualización en Storage (nuevo método)
  if (!html && minuta.docxPreviewURL) {
    try {
      const resp = await fetch(minuta.docxPreviewURL);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > 0) {
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          html = result.value || "";
        }
      }
    } catch(_) {}
  }

  // Fuente 2: Base64 de previsualización en Firestore (minutas antiguas)
  if (!html && minuta.docxPreviewBase64) {
    try {
      const binary = atob(minuta.docxPreviewBase64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (bytes.length > 0) {
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
        html = result.value || "";
      }
    } catch(_) {}
  }

  // Fuente 3: Base64 del archivo de trabajo en Firestore
  if (!html && minuta.docxBase64) {
    try {
      const binary = atob(minuta.docxBase64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (bytes.length > 0) {
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
        html = result.value || "";
      }
    } catch(_) {}
  }

  // Fuente 4: URL del archivo de trabajo en Storage
  if (!html && minuta.archivoURL) {
    try {
      const resp = await fetch(minuta.archivoURL);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > 0) {
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          html = result.value || "";
        }
      }
    } catch(_) {}
  }

  // Fallback: mostrar descripción si ninguna fuente funcionó
  if (!html) {
    html = `<p><strong>${esc(minuta.nombre)}</strong></p><p>${esc(minuta.descripcion||"")}</p><p style="color:var(--text-muted);font-size:0.83rem;margin-top:14px;padding:10px 14px;background:#f8f7f4;border-radius:8px;border:1px solid var(--border);">La previsualización del documento no está disponible. Para ver el documento completo, adquiere la minuta.</p>`;
  }

  content.innerHTML = `<div class="word-page">${html}</div>`;

  let seg = 10;
  bar.style.transition = "none";
  bar.style.width = "100%";
  timerTxt.innerHTML = `Vista por <strong>${seg}s</strong>`;
  if (_previewTimer) clearInterval(_previewTimer);
  void bar.offsetWidth;
  bar.style.transition = "width 1s linear";
  _previewTimer = setInterval(() => {
    seg--;
    const pct = (seg / 10) * 100;
    bar.style.width = pct + "%";
    timerTxt.innerHTML = `Vista por <strong>${seg}s</strong>`;
    if (seg <= 0) cerrarPreviewTimed();
  }, 1000);
}

function cerrarPreviewTimed() {
  if (_previewTimer) { clearInterval(_previewTimer); _previewTimer = null; }
  const overlay = document.getElementById("preview-timed-overlay");
  overlay.classList.remove("open");
  document.getElementById("preview-timed-content").innerHTML = '<div class="loading-spinner"></div>';
  // Restaurar footer por si fue ocultado en el modal de bloqueo
  const footer = overlay.querySelector(".preview-timed-footer");
  if (footer) footer.style.display = "";
}

async function simularPago() {
  if (!currentUser) { pedirInicioSesion(); return; }
  const ref = "TEST-" + Date.now();
  await registrarVenta(ref, "simulado", "prueba");
  pagoExitoso = true;
  renderStep(getTotalSteps());
  toast("Pago simulado. Descarga tu documento ahora.", "ok");
}

function generarReferenciaUnica() {
  const ts   = Date.now();
  const rand = Math.random().toString(36).substring(2,8).toUpperCase();
  return `ML-${ts}-${rand}`;
}

async function calcularIntegritySignature(reference, amountInCents, currency, secret) {
  const cadena     = `${reference}${amountInCents}${currency}${secret}`;
  const encoder    = new TextEncoder();
  const data       = encoder.encode(cadena);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2,"0")).join("");
}

async function iniciarPagoWompi() {
  if (!currentUser) { pedirInicioSesion(); return; }
  if (!wompiConfig.publicKey) { toast("La pasarela de pago no está configurada. Contacta al administrador.", "error"); return; }
  if (!currentMinuta) return;

  const btn = document.getElementById("btn-pagar-wompi");
  btn.disabled = true; btn.textContent = "Preparando pago...";

  try {
    const amountInCents = Math.round((currentMinuta.precio || 0) * 100);
    const reference = generarReferenciaUnica();
    const currency  = "COP";

    const checkoutConfig = {
      currency, amountInCents, reference,
      publicKey: wompiConfig.publicKey,
      customerData: { email: currentUser.email }
    };

    if (wompiConfig.integritySecret) {
      try {
        const signature = await calcularIntegritySignature(reference, amountInCents, currency, wompiConfig.integritySecret);
        checkoutConfig.signature = { integrity: signature };
      } catch(e) {}
    }

    const checkout = new WidgetCheckout(checkoutConfig);
    btn.disabled = false; btn.textContent = "Pagar ahora";

    checkout.open(async result => {
      const { transaction } = result;
      if (!transaction) return;
      currentWompiTransactionId = transaction.id;
      if (transaction.status === "APPROVED") {
        await registrarVenta(reference, transaction.id, "wompi");
        pagoExitoso = true;
        renderStep(getTotalSteps());
      } else if (["PENDING","IN_VALIDATION"].includes(transaction.status)) {
        document.getElementById("wompi-checkout-section").style.display = "none";
        document.getElementById("wompi-pending-section").style.display = "block";
      } else {
        toast("El pago fue rechazado o cancelado. Intenta de nuevo.", "error");
      }
    });
  } catch(err) {
    toast("Error al iniciar el pago: " + err.message, "error");
    btn.disabled = false; btn.textContent = "Pagar ahora";
  }
}

async function verificarEstadoPago() {
  if (!currentWompiTransactionId) return;
  try {
    const resp = await fetch(`https://sandbox.wompi.co/v1/transactions/${currentWompiTransactionId}`);
    const data = await resp.json();
    const tx   = data.data;
    if (tx && tx.status === "APPROVED") {
      await registrarVenta(tx.reference, tx.id, "wompi");
      pagoExitoso = true;
      renderStep(getTotalSteps());
    } else {
      toast("El pago aún no ha sido aprobado. Intenta en unos minutos.", "");
    }
  } catch(e) { toast("Error verificando el pago.", "error"); }
}

async function registrarVenta(reference, transactionId, metodoPago) {
  if (!db || !currentUser || !currentMinuta) return;
  try {
    await db.collection("ventas").add({
      userId: currentUser.uid, userEmail: currentUser.email,
      minutaId: currentMinuta.id, minutaNombre: currentMinuta.nombre,
      precio: currentMinuta.precio || 0, metodoPago, reference, transactionId,
      estado: "pagado", createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) {}
}

/* ── CARGAR CONFIG OPENAI ── */
async function cargarGeminiConfig() {
  if (!db) return;
  try {
    const snap = await db.collection("config").doc("openai").get();
    if (snap.exists) geminiConfig = snap.data();
  } catch(_) {}
}

/* ── GUARDAR CONFIG OPENAI ── */
async function guardarOpenAIConfig(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-guardar-gemini");
  btn.disabled = true; btn.textContent = "Guardando...";
  const apiKey = document.getElementById("gemini-api-key").value.trim();
  if (!apiKey) {
    toast("Escribe la clave de API de Groq.", "error");
    btn.disabled = false; btn.textContent = "Guardar clave de Groq";
    return;
  }
  if (!apiKey.startsWith("gsk_")) {
    toast("La clave de Groq debe comenzar con 'gsk_'.", "error");
    btn.disabled = false; btn.textContent = "Guardar clave de Groq";
    return;
  }
  if (!db) { toast("Firebase no configurado.", "error"); btn.disabled = false; btn.textContent = "Guardar clave de Groq"; return; }
  try {
    await db.collection("config").doc("openai").set({ apiKey });
    geminiConfig = { apiKey };
    toast("Clave de Groq guardada correctamente.", "ok");
    const statusEl = document.getElementById("gemini-config-status");
    statusEl.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ Groq configurado. La IA está lista para usarse.</p>`;
  } catch(e) { toast("Error al guardar: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar clave de Groq"; }
}

/* ── GUARDAR WOMPI CONFIG ── */
async function guardarWompiConfig(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-guardar-wompi");
  btn.disabled = true; btn.textContent = "Guardando...";
  const publicKey       = document.getElementById("wompi-public-key").value.trim();
  const integritySecret = document.getElementById("wompi-integrity-secret").value.trim();
  const mode            = document.getElementById("wompi-mode").value;
  if (!db) { toast("Firebase no configurado.", "error"); btn.disabled = false; btn.textContent = "Guardar configuración Wompi"; return; }
  try {
    await db.collection("config").doc("wompi").set({ publicKey, integritySecret, mode });
    wompiConfig = { publicKey, integritySecret, mode };
    toast("Configuración Wompi guardada.", "ok");
    const statusEl = document.getElementById("wompi-config-status");
    if (publicKey) statusEl.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">Wompi configurado en modo ${mode === "prod" ? "Producción" : "Pruebas"}.</p>`;
  } catch(e) { toast("Error al guardar: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar configuración Wompi"; }
}

/* ══════════════════════════════════════════════════════
   REEMPLAZAR CAMPOS EN DOCX
   Algoritmo basado en posición de caracteres por run:
   1. Limpiar marcas de Word que fragmentan texto
   2. Para cada párrafo, extraer runs con su texto y posición
   3. Localizar el campo usando posición exacta de char → run
   4. Reemplazar solo los runs del campo, preservando rPr del
      primer run (negrilla, cursiva, etc.)
   ══════════════════════════════════════════════════════ */

/* Extrae el texto completo de un bloque XML leyendo todos sus <w:t> */
function extraerTextoParagrafo(parrafoXml) {
  const matches = [...parrafoXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
  return matches.map(m => m[1]).join("");
}

/* Extrae los runs de un párrafo con posición, texto y rPr */
function extraerRuns(pBody) {
  const runRegex = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  const runs = [];
  let rm;
  while ((rm = runRegex.exec(pBody)) !== null) {
    const runXml = rm[0];
    const wts = [...runXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
    const text = wts.map(m => m[1]).join("");
    const rPrM = runXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    runs.push({
      xml: runXml,
      text,
      rPr: rPrM ? rPrM[0] : "",
      pBodyStart: rm.index,
      pBodyEnd: rm.index + rm[0].length
    });
  }
  return runs;
}

/* Reemplaza un campo dentro de un párrafo conociendo sus runs.
   Devuelve el pBody modificado, o null si el campo no está en este párrafo. */
function reemplazarCampoEnParrafo(pBody, campoUP, valorStr, tieneNewline) {
  const runs = extraerRuns(pBody);
  if (!runs.length) return null;

  const fullText = runs.map(r => r.text).join("");
  const fullTextUP = fullText.toUpperCase();
  const idx = fullTextUP.indexOf(campoUP);
  if (idx === -1) return null;

  const idxEnd = idx + campoUP.length;

  // Mapear posición de char → índice de run
  let charPos = 0;
  let firstRunIdx = -1, lastRunIdx = -1;
  for (let i = 0; i < runs.length; i++) {
    const runStart = charPos;
    const runEnd = charPos + runs[i].text.length;
    if (firstRunIdx === -1 && runEnd > idx) firstRunIdx = i;
    if (runStart < idxEnd) lastRunIdx = i;
    charPos = runEnd;
  }
  if (firstRunIdx === -1 || lastRunIdx === -1) return null;

  // rPr del run donde empieza el campo (preserva negrilla/cursiva/color)
  const rPr = runs[firstRunIdx].rPr;
  const pPrM = pBody.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  const pPr = pPrM ? pPrM[0] : "";

  // Texto antes del campo dentro del primer run afectado
  let charBefore = 0;
  for (let i = 0; i < firstRunIdx; i++) charBefore += runs[i].text.length;
  const prefixText = fullText.substring(charBefore, idx);

  // Texto después del campo dentro del último run afectado
  let charBeforeLast = 0;
  for (let i = 0; i < lastRunIdx; i++) charBeforeLast += runs[i].text.length;
  const suffixText = fullText.substring(idxEnd, charBeforeLast + runs[lastRunIdx].text.length);

  // Construir el XML de reemplazo (solo los runs que contienen el campo)
  const buildRun = (rp, txt) =>
    `<w:r>${rp}<w:t xml:space="preserve">${xmlEsc(txt)}</w:t></w:r>`;

  if (!tieneNewline) {
    let replacement = "";
    if (prefixText) replacement += buildRun(rPr, prefixText);
    replacement += buildRun(rPr, valorStr);
    if (suffixText) replacement += buildRun(runs[lastRunIdx].rPr, suffixText);

    // Reemplazar en pBody solo los runs afectados, preservando todo lo demás
    const newBody =
      pBody.substring(0, runs[firstRunIdx].pBodyStart) +
      replacement +
      pBody.substring(runs[lastRunIdx].pBodyEnd);
    return newBody;
  } else {
    // Multilinea: expandir en múltiples <w:p>
    const lineas = valorStr.split(/\r?\n/);
    const parrafos = lineas.map((linea, li) => {
      let content = pPr;
      if (li === 0 && prefixText) content += buildRun(rPr, prefixText);
      content += buildRun(rPr, linea);
      if (li === lineas.length - 1 && suffixText) content += buildRun(runs[lastRunIdx].rPr, suffixText);
      return `<w:p>${content}</w:p>`;
    }).join("");
    return parrafos; // devuelve string que reemplaza el <w:p> completo
  }
}

async function reemplazarEnDocx(blob, campos) {
  const buf = await blob.arrayBuffer();
  const zip  = new PizZip(buf);

  const archivos = [
    "word/document.xml",
    "word/header1.xml","word/header2.xml",
    "word/footer1.xml","word/footer2.xml"
  ];

  // Construir entradas con 3 variantes de formato por campo:
  // texto plano, {{campo}} y [campo] — el Word puede usar cualquiera
  const entradas = Object.entries(campos)
    .flatMap(([c, v]) => {
      const norm = c.replace(/\s+/g, " ").trim();
      const up   = norm.toUpperCase();
      const base = { valorStr: String(v), tieneNewline: String(v).includes("\n") };
      return [
        { ...base, campoNorm: norm,          campoUP: up },
        { ...base, campoNorm: `{{${norm}}}`, campoUP: `{{${up}}}` },
        { ...base, campoNorm: `[${norm}]`,   campoUP: `[${up}]` },
      ];
    })
    .sort((a, b) => b.campoNorm.length - a.campoNorm.length);

  archivos.forEach(f => {
    if (!zip.files[f]) return;
    let xml = zip.files[f].asText();

    // ── LIMPIEZA: quitar todas las marcas de Word que fragmentan texto entre runs
    xml = xml
      .replace(/<w:proofErr[^>]*\/?>/g, "")
      .replace(/<\/w:proofErr>/g, "")
      .replace(/<w:rsid[A-Za-z]*="[^"]*"/g, "")
      .replace(/<w:bookmarkStart[^>]*\/?>/g, "")
      .replace(/<w:bookmarkEnd[^>]*\/?>/g, "")
      .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
      .replace(/<w:ins\b[^>]*>/g, "")
      .replace(/<\/w:ins>/g, "")
      .replace(/<w:rPrChange\b[\s\S]*?<\/w:rPrChange>/g, "")
      .replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "");

    // ── REEMPLAZO: procesar párrafo por párrafo, campo por campo
    for (const { campoNorm, campoUP, valorStr, tieneNewline } of entradas) {
      xml = xml.replace(/(<w:p\b[^>]*>)([\s\S]*?)(<\/w:p>)/g, (match, pOpen, pBody, pClose) => {
        const resultado = reemplazarCampoEnParrafo(pBody, campoUP, valorStr, tieneNewline);
        if (resultado === null) return match;
        console.log(`[DOCX ✅] "${campoNorm}" → "${valorStr.toString().substring(0,40)}"`);
        // Para multilinea, resultado ya incluye los <w:p> completos
        if (tieneNewline) return resultado;
        return pOpen + resultado + pClose;
      });
    }

    zip.file(f, xml);
  });

  return zip.generate({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}

/* ── DESCARGA ── */
function setupDescarga() {
  const nombreArchivo = (currentMinuta.nombre||"minuta").replace(/\s+/g,"_");

  // Actualizar mensaje según si se usó IA o no
  const msgEl = document.getElementById("descarga-msg");
  if (msgEl) {
    const usaIA = minutaTieneIA && Object.keys(camposIAMejorados).length > 0;
    if (usaIA) {
      msgEl.textContent = "Tu minuta fue personalizada con los datos que ingresaste y la IA mejoró la redacción. Descárgala ahora.";
    } else {
      msgEl.textContent = "Tu minuta fue personalizada con los datos que ingresaste. Descárgala ahora.";
    }
  }

  document.getElementById("btn-download-word").onclick = async () => {
    // Validar que los campos extra de cláusulas incluidas estén llenos
    if (minutaClausulas && minutaClausulas.length > 0) {
      saveClausulasActuales();
      const resClausulas = validateClausulas();
      if (!resClausulas.ok) {
        marcarCamposExtraFaltantes();
        toast(resClausulas.razon, "error");
        return;
      }
    }

    // Si aún no tenemos el blob (archivo grande o carga diferida falló), intentar de nuevo desde la URL
    if (!docxBlob && currentMinuta.archivoURL) {
      toast("Obteniendo archivo de trabajo...", "");
      try {
        const resp = await fetch(currentMinuta.archivoURL, { mode: "cors" });
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          docxBlob = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        } else {
          console.warn("[Descarga] fetch archivoURL respondió con estado:", resp.status);
          toast("Error al obtener el archivo (" + resp.status + "). Verifica las reglas de acceso en Firebase Storage.", "error");
        }
      } catch(fetchErr) {
        console.warn("[Descarga] fetch falló (posible CORS o red):", fetchErr.message);
        toast("No se pudo descargar el archivo de plantilla. Verifica que las reglas de Firebase Storage permitan lectura pública (allow read: if true;) y que CORS esté configurado.", "error");
      }
    }

    if (docxBlob) {
      // Combinar campos normales + campos IA mejorados + campos extra de cláusulas incluidas
      const camposDeClausulas = {};
      if (minutaClausulas && minutaClausulas.length > 0) {
        for (const cl of minutaClausulas) {
          if (eleccionesClausulas[cl.id] === true && cl.camposExtra && cl.camposExtra.length) {
            for (const campo of cl.camposExtra) {
              const valor = (camposClausulas[cl.id + "_" + campo] || "").trim();
              if (valor) camposDeClausulas[campo] = valor;
            }
          }
        }
      }
      const todosLosCampos = { ...camposLlenados, ...camposIAMejorados, ...camposDeClausulas };
      const nCampos = Object.keys(todosLosCampos).length;

      console.log("[Descarga] docxBlob disponible. Campos a reemplazar:", nCampos, todosLosCampos);

      let blobFinal = docxBlob;

      // Paso 1: Aplicar elecciones de cláusulas opcionales (eliminar excluidas y renumerar)
      if (minutaClausulas && minutaClausulas.length > 0) {
        try {
          toast("Aplicando selección de cláusulas…", "");
          const bufferConElecciones = await aplicarEleccionesEnDocx(await blobFinal.arrayBuffer());
          blobFinal = new Blob([bufferConElecciones], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        } catch(err) {
          console.error("[Descarga] Error aplicando elecciones de cláusulas:", err);
          toast("⚠️ Error procesando cláusulas opcionales: " + (err.message || err), "error");
        }
      }

      // Paso 2: Reemplazar campos personalizables normales e IA
      if (nCampos > 0) {
        toast(`Insertando ${nCampos} campo(s) en el documento…`, "");
        try {
          blobFinal = await reemplazarEnDocx(blobFinal, todosLosCampos);
          toast("✅ Datos insertados. Descargando…", "");
        } catch(err) {
          console.error("[Descarga] Error al personalizar el documento:", err);
          toast("⚠️ No se pudieron insertar los datos: " + (err.message || err), "error");
        }
      }

      const url = URL.createObjectURL(blobFinal);
      const a   = document.createElement("a");
      a.href = url; a.download = nombreArchivo + ".docx"; a.click();
      URL.revokeObjectURL(url);
      return;
    }

    // Sin blob: descargar el original sin personalización
    if (currentMinuta.archivoURL) {
      toast("⚠️ No se pudo obtener el archivo para personalizarlo. Descargando el original.", "error");
      const a = document.createElement("a");
      a.href = currentMinuta.archivoURL; a.target = "_blank"; a.download = nombreArchivo + ".docx"; a.click();
      return;
    }
    toast("Archivo no disponible.", "error");
  };
}

/* ── VISTA PREVIA POST-PAGO (documento con datos del usuario) ── */

async function generarBlobFinal() {
  let blobFinal = docxBlob;
  if (!blobFinal && currentMinuta.archivoURL) {
    try {
      const resp = await fetch(currentMinuta.archivoURL, { mode: "cors" });
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        blobFinal = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        docxBlob = blobFinal;
      }
    } catch(_) {}
  }
  if (!blobFinal) return null;

  // Aplicar elecciones de cláusulas
  if (minutaClausulas && minutaClausulas.length > 0) {
    try {
      const bufConElecciones = await aplicarEleccionesEnDocx(await blobFinal.arrayBuffer());
      blobFinal = new Blob([bufConElecciones], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    } catch(_) {}
  }

  // Reemplazar campos
  const camposDeClausulas = {};
  if (minutaClausulas && minutaClausulas.length > 0) {
    for (const cl of minutaClausulas) {
      if (eleccionesClausulas[cl.id] === true && cl.camposExtra && cl.camposExtra.length) {
        for (const campo of cl.camposExtra) {
          const valor = (camposClausulas[cl.id + "_" + campo] || "").trim();
          if (valor) camposDeClausulas[campo] = valor;
        }
      }
    }
  }
  const todosLosCampos = { ...camposLlenados, ...camposIAMejorados, ...camposDeClausulas };
  if (Object.keys(todosLosCampos).length > 0) {
    try { blobFinal = await reemplazarEnDocx(blobFinal, todosLosCampos); } catch(_) {}
  }
  return blobFinal;
}

async function abrirPreviewPostpago() {
  const overlay = document.getElementById("preview-postpago-overlay");
  const content = document.getElementById("preview-postpago-content");
  if (!overlay || !content) return;

  content.innerHTML = '<div class="loading-spinner"></div>';
  overlay.classList.add("open");

  try {
    const blobFinal = await generarBlobFinal();
    if (!blobFinal) {
      content.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:30px;">No se pudo generar la vista previa del documento.</p>';
      return;
    }
    const buf = await blobFinal.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    const html = result.value || "<p>El documento no tiene contenido visible.</p>";
    content.innerHTML = `<div class="word-page">${html}</div>`;
  } catch(err) {
    content.innerHTML = '<p style="text-align:center;color:var(--danger);padding:30px;">Error al generar la vista previa: ' + esc(err.message || err) + '</p>';
  }
}

function cerrarPreviewPostpago() {
  const overlay = document.getElementById("preview-postpago-overlay");
  if (overlay) overlay.classList.remove("open");
}

function editarDatosPostpago() {
  cerrarPreviewPostpago();
  // Volver al paso 1 (Mis datos); pagoExitoso sigue en true así que no re-cobra
  camposCurrentPage = 1;
  renderStep(1);
}

function descargarDesdePreview() {
  cerrarPreviewPostpago();
  document.getElementById("btn-download-word").click();
}

function switchAuthTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("tab-login-btn").classList.toggle("active", isLogin);
  document.getElementById("tab-register-btn").classList.toggle("active", !isLogin);
  document.getElementById("auth-form-login").classList.toggle("active", isLogin);
  document.getElementById("auth-form-recuperar").classList.remove("active");
  document.getElementById("auth-form-register").classList.toggle("active", !isLogin);
  document.querySelectorAll(".auth-tab").forEach(t => t.style.display = "");
}

function mostrarRecuperacion() {
  document.getElementById("auth-form-login").classList.remove("active");
  document.getElementById("auth-form-register").classList.remove("active");
  document.getElementById("auth-form-recuperar").classList.add("active");
  document.getElementById("recuperar-idle").style.display = "";
  document.getElementById("recuperar-ok").style.display = "none";
  document.getElementById("recuperar-email").value = "";
  document.querySelectorAll(".auth-tab").forEach(t => t.style.display = "none");
}

function ocultarRecuperacion() {
  switchAuthTab("login");
}

document.getElementById("form-recuperar").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-recuperar");
  const email = document.getElementById("recuperar-email").value.trim();
  btn.disabled = true; btn.textContent = "Enviando...";
  try {
    const actionCodeSettings = {
      url: "https://" + firebaseConfig.authDomain,
      handleCodeInApp: false
    };
    await auth.sendPasswordResetEmail(email, actionCodeSettings);
    document.getElementById("recuperar-idle").style.display = "none";
    document.getElementById("recuperar-ok").style.display = "";
  } catch(err) {
    const msgs = {
      "auth/user-not-found": "No existe una cuenta con ese correo. Verifica que sea el correo con el que te registraste.",
      "auth/invalid-email": "El correo no tiene un formato válido.",
      "auth/invalid-credential": "No existe una cuenta con ese correo. Verifica que sea el correo con el que te registraste.",
      "auth/too-many-requests": "Demasiados intentos. Espera unos minutos antes de intentar de nuevo.",
      "auth/missing-email": "Por favor ingresa tu correo electrónico.",
      "auth/unauthorized-continue-uri": "Error de configuración del dominio. Contacta al administrador.",
    };
    toast(msgs[err.code] || "No se pudo enviar el correo. Intenta de nuevo.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Enviar enlace";
  }
});

function cerrarModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  document.body.style.overflow = "";
}

/* Redirige al login guardando el estado COMPLETO del formulario para retomarlo después. */
function pedirInicioSesion() {
  // Capturar todo el progreso actual (campos, IA, cláusulas)
  try { saveCamposActuales(); }    catch(_) {}
  try { saveCamposIAActuales(); }  catch(_) {}
  try { saveClausulasActuales(); } catch(_) {}

  pendingMinutaId = currentMinuta ? currentMinuta.id : null;
  if (pendingMinutaId) {
    pendingResumeState = {
      camposLlenados:      { ...camposLlenados },
      camposIALlenados:    { ...camposIALlenados },
      camposIAMejorados:   { ...camposIAMejorados },
      eleccionesClausulas: { ...eleccionesClausulas },
      camposClausulas:     { ...camposClausulas },
      currentStep:         currentStep,
      camposCurrentPage:   camposCurrentPage,
      iaYaProcesada:       iaYaProcesada
    };
  } else {
    pendingResumeState = null;
  }
  pendingCamposSnapshot = pendingResumeState ? { ...pendingResumeState.camposLlenados } : null; // legacy

  cerrarModal();
  showSection("usuarios");
  toast("Inicia sesión para continuar — tus datos se conservarán.", "");
}

/* Restaura el modal de adquisición al estado guardado en pendingResumeState
   y reanuda al usuario en el mismo paso donde estaba antes del login. */
function restaurarEstadoModal(state) {
  if (!state) return;
  camposLlenados      = { ...(state.camposLlenados      || {}) };
  camposIALlenados    = { ...(state.camposIALlenados    || {}) };
  camposIAMejorados   = { ...(state.camposIAMejorados   || {}) };
  eleccionesClausulas = { ...(state.eleccionesClausulas || {}) };
  camposClausulas     = { ...(state.camposClausulas     || {}) };
  iaYaProcesada       = !!state.iaYaProcesada;
  camposCurrentPage   = state.camposCurrentPage || 1;

  const totalSteps = getTotalSteps();
  let targetStep   = Math.min(Math.max(1, state.currentStep || 1), totalSteps);

  // Si estaba en pago/descarga y todavía no había pagado, lo mandamos al pago.
  // Si estaba en un paso de formulario, lo dejamos donde estaba para que vea sus datos.
  renderStep(targetStep);
  // Refrescar la previsualización con los datos restaurados
  if (typeof actualizarLivePreview === "function") {
    try { actualizarLivePreview(); } catch(_) {}
  }
}
document.getElementById("modal-close").addEventListener("click", cerrarModal);
document.getElementById("modal-overlay").addEventListener("click", e => {
  if (e.target === document.getElementById("modal-overlay")) cerrarModal();
});

/* ═══════════════════════════════════════════════════════
   ADMIN — SUBIR MINUTA CON DETECCIÓN DE IA
═══════════════════════════════════════════════════════ */

/* Patrón para detectar placeholders de IA en el texto del Word */
// Patrón canónico: ESPACIO PARA EL TEXTO DE LA IAn (LABEL)
// Ejemplo: ESPACIO PARA EL TEXTO DE LA IA1 (HECHOS)
//          ESPACIO PARA EL TEXTO DE LA IA2 (PRETENSIONES)
const AI_PLACEHOLDER_REGEX = /ESPACIO PARA EL TEXTO DE LA IA\d+\s*\([^)]+\)/gi;

/* Extrae el texto plano de un XML de Word uniendo todos los <w:t> */
function extractTextFromDocxXml(xmlText) {
  // Eliminar marcas que pueden partir el texto entre runs
  const limpio = xmlText
    .replace(/<w:proofErr[^>]*\/>/g, "")
    .replace(/<w:bookmarkStart[^>]*\/>/g, "")
    .replace(/<w:bookmarkEnd[^>]*\/>/g, "")
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")   // eliminar texto eliminado/revisado
    .replace(/<w:rPrChange\b[\s\S]*?<\/w:rPrChange>/g, "")
    .replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "");
  const matches = [...limpio.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
  // Unir sin espacios para evitar que Word fragmente palabras como "ELECC ION USUA RIO"
  return matches.map(m => m[1]).join("");
}

/* Detecta los placeholders de IA en el buffer del docx.
   Devuelve un array de strings con el texto EXACTO tal como aparece
   en el documento (ej: "ESPACIO PARA EL TEXTO DE LA IA1 (HECHOS)"). */

/* ══════════════════════════════════════════════════════════
   CLÁUSULAS OPCIONALES — ELECCION USUARIO
   Marcadores en el Word: el texto "ELECCION USUARIO" aparece
   al principio Y al final de cada cláusula opcional.
   Los bloques pueden contener múltiples párrafos.
══════════════════════════════════════════════════════════ */

/* Detecta bloques ELECCION USUARIO en el DOCX.
   Devuelve un array de objetos: [{id, titulo, preview, camposExtra:[]}] */
async function detectarClausulasEleccion(arrayBuffer) {
  const zip = new PizZip(arrayBuffer);
  if (!zip.files["word/document.xml"]) return [];

  const xmlText = zip.files["word/document.xml"].asText();

  // Limpiar marcas de Word que parten el texto dentro de párrafos
  const limpio = xmlText
    .replace(/<w:proofErr[^>]*\/>/g, "")
    .replace(/<w:bookmarkStart[^>]*\/>/g, "")
    .replace(/<w:bookmarkEnd[^>]*\/>/g, "")
    .replace(/<w:rPrChange[^>]*>[\s\S]*?<\/w:rPrChange>/g, "")
    .replace(/<w:pPrChange[^>]*>[\s\S]*?<\/w:pPrChange>/g, "");

  // Dividir en párrafos Word <w:p>...</w:p>
  const parrafoRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const parrafos = [];
  let m;
  while ((m = parrafoRe.exec(limpio)) !== null) {
    const textoParrafo = extractTextFromDocxXml(m[0]).trim();
    parrafos.push({ xml: m[0], texto: textoParrafo, idx: parrafos.length });
  }

  const MARCA = /ELECCION\s*USUARIO/i;
  const clausulas = [];
  let dentroBloque = false;
  let inicioIdx = -1;

  for (let i = 0; i < parrafos.length; i++) {
    const texto = parrafos[i].texto;
    if (MARCA.test(texto)) {
      if (!dentroBloque) {
        // Inicio del bloque
        dentroBloque = true;
        inicioIdx = i;
      } else {
        // Fin del bloque
        dentroBloque = false;
        const bloqueParrafos = parrafos.slice(inicioIdx, i + 1);
        // Texto de preview = primeros párrafos sin la marca
        const contenido = bloqueParrafos
          .slice(1, -1) // sin marcadores inicio y fin
          .map(p => p.texto)
          .filter(Boolean)
          .join("\n");
        const preview = contenido.substring(0, 300) + (contenido.length > 300 ? "..." : "");

        // Intentar extraer el título de la cláusula (PRIMERO/PRIMERA/SEGUNDA, etc. o primera línea)
        const ORDINAL_RE = /^(PRIMER[AO]|SEGUND[AO]|TERCER[AO]|CUART[AO]|QUINT[AO]|SEXT[AO]|S[EÉ]PTIM[AO]|OCTAV[AO]|NOVEN[AO]|D[EÉ]CIM[AO])[:\s\-\.]/i;
        let titulo = `Cláusula opcional ${clausulas.length + 1}`;
        for (const p of bloqueParrafos.slice(1, -1)) {
          if (p.texto && ORDINAL_RE.test(p.texto)) {
            titulo = p.texto.substring(0, 80).trim();
            break;
          } else if (p.texto && p.texto.length > 3) {
            titulo = p.texto.substring(0, 80).trim();
            break;
          }
        }

        clausulas.push({
          id: "clausula_" + clausulas.length,
          titulo,
          preview,
          contenido, // texto completo sin truncar
          inicioIdx,
          finIdx: i,
          camposExtra: []
        });
        inicioIdx = -1;
      }
    }
  }

  return clausulas;
}

/* Admin: procesa la respuesta sobre si el documento tiene cláusulas ELECCION USUARIO */
async function confirmarEleccionUsuario(tiene) {
  const eleccionResult = document.getElementById("eleccion-detected-result");
  eleccionResult.style.display = "block";

  if (!tiene) {
    adminClausulasEleccion = [];
    eleccionResult.innerHTML = "<p style='color:var(--text-muted);font-size:0.87rem;'>Sin cláusulas opcionales. Los clientes no tendrán elección de cláusulas.</p>";
    return;
  }

  if (!adminDocxBuffer) {
    toast("Primero selecciona un archivo Word.", "error"); return;
  }

  eleccionResult.innerHTML = "<p style='color:var(--text-muted);font-size:0.87rem;'>Analizando cláusulas...</p>";

  try {
    const clausulas = await detectarClausulasEleccion(adminDocxBuffer);

    if (!clausulas.length) {
      adminClausulasEleccion = [];
      eleccionResult.innerHTML = `
        <div class="eleccion-detected-box" style="border-color:rgba(192,57,43,0.3);background:rgba(192,57,43,0.07);">
          <p style="color:var(--danger);">⚠ No se encontraron marcadores ELECCION USUARIO en el documento.</p>
          <p style="font-size:0.82rem;color:var(--text-muted);margin-top:6px;">
            Asegúrate de que el Word contenga exactamente el texto <strong>ELECCION USUARIO</strong>
            (en mayúsculas) al inicio y al final de cada cláusula opcional que deseas configurar.
          </p>
        </div>`;
      return;
    }

    adminClausulasEleccion = clausulas;
    renderAdminClausulasConfig();
  } catch(ex) {
    eleccionResult.innerHTML = `<p style='color:var(--danger);'>Error analizando el archivo: ${esc(ex.message)}</p>`;
  }
}

/* Renderiza en el admin el formulario para configurar las cláusulas detectadas */
function renderAdminClausulasConfig() {
  const eleccionResult = document.getElementById("eleccion-detected-result");
  const clausulas = adminClausulasEleccion;

  const itemsHtml = clausulas.map((cl, idx) => `
    <div class="eleccion-item" id="admin-clausula-${idx}">
      <div class="eleccion-item-label">📌 Cláusula ${idx + 1}: ${esc(cl.titulo)}</div>
      <div class="clausula-opcion-preview" style="max-height:80px;">${esc(cl.preview)}</div>
      <div class="eleccion-campos-extra-input">
        <label>Campos adicionales si el cliente <strong>incluye</strong> esta cláusula (separados por coma):</label>
        <input type="text"
               class="form-input"
               placeholder="Ej: NOMBRE ARRENDATARIO, FECHA DE INICIO, VALOR MENSUAL"
               id="admin-clausula-campos-${idx}"
               value="${esc((cl.camposExtra||[]).join(", "))}"
               oninput="actualizarCamposExtraClausula(${idx})"
               style="margin-top:4px;" />
        <p style="font-size:0.78rem;color:var(--text-muted);margin-top:3px;">
          Estos campos serán pedidos al cliente si decide incluir esta cláusula.
          Usa los mismos nombres que en el Word (sin llaves). Deja vacío si no hay campos adicionales.
        </p>
      </div>
    </div>`).join("");

  eleccionResult.innerHTML = `
    <div class="eleccion-detected-box">
      <p>✅ Se detectaron ${clausulas.length} cláusula(s) opcional(es)</p>
      ${itemsHtml}
    </div>`;
}

/* Actualiza los camposExtra de una cláusula cuando el admin escribe */
function actualizarCamposExtraClausula(idx) {
  const input = document.getElementById("admin-clausula-campos-" + idx);
  if (!input) return;
  const campos = input.value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (adminClausulasEleccion[idx]) {
    adminClausulasEleccion[idx].camposExtra = campos;
  }
}

/* ── Convierte texto plano a HTML de párrafos para el visor Word ── */
function textoPlanoAHtml(texto) {
  if (!texto) return "";
  return texto
    .split(/\n\n+/)
    .map(parrafo => {
      const lineas = parrafo
        .split("\n")
        .map(l => esc(l.trim()))
        .filter(l => l.length > 0)
        .join("<br>");
      return lineas ? `<p>${lineas}</p>` : "";
    })
    .filter(p => p.length > 0)
    .join("");
}

/* ══════════════════════════════════════════════════════════
   CLIENTE — PASO DE CLÁUSULAS OPCIONALES
══════════════════════════════════════════════════════════ */

/* Construye la vista de LISTADO de cláusulas (vista principal) */
function buildClausulasForm() {
  const container = document.getElementById("clausulas-dinamicas");
  if (!container) return;
  mostrarListaClausulas();
}

/* Renderiza el menú/listado de todas las cláusulas */
function mostrarListaClausulas() {
  const container = document.getElementById("clausulas-dinamicas");
  if (!container) return;

  const pendientes = minutaClausulas.filter(cl => eleccionesClausulas[cl.id] === undefined || eleccionesClausulas[cl.id] === null).length;

  container.innerHTML = `
    ${pendientes > 0 ? `<p class="clausulas-pendientes-aviso">⚠️ ${pendientes} cláusula${pendientes > 1 ? 's' : ''} sin decisión — haz clic en cada una para leerla y elegir.</p>` : ""}
    <div class="clausulas-lista">
      ${minutaClausulas.map((cl, idx) => {
        const incluida = eleccionesClausulas[cl.id] === true;
        const excluida = eleccionesClausulas[cl.id] === false;
        const estadoClass = incluida ? 'seleccionada' : excluida ? 'excluida' : '';
        const estadoIcon = incluida ? '✅' : excluida ? '✗' : '📌';
        const estadoTexto = incluida ? 'Incluida' : excluida ? 'Excluida' : 'Sin decidir';
        const estadoBadgeClass = incluida ? 'badge-ok' : excluida ? 'badge-no' : 'badge-pendiente';
        return `
          <button class="clausula-lista-item ${estadoClass}" onclick="mostrarDetalleClausula(${idx})">
            <span class="clausula-lista-icono">${estadoIcon}</span>
            <span class="clausula-lista-titulo">${esc(cl.titulo)}</span>
            <span class="clausula-lista-badge ${estadoBadgeClass}">${estadoTexto}</span>
            <svg class="clausula-lista-flecha" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
            </svg>
          </button>`;
      }).join("")}
    </div>`;
}

/* Renderiza la vista de DETALLE de una cláusula específica */
function mostrarDetalleClausula(idx) {
  const container = document.getElementById("clausulas-dinamicas");
  const cl = minutaClausulas[idx];
  if (!container || !cl) return;

  const incluida = eleccionesClausulas[cl.id] === true;
  const excluida = eleccionesClausulas[cl.id] === false;
  const total = minutaClausulas.length;

  // Texto completo: usa contenido si está disponible, si no el preview
  const textoCompleto = cl.contenido || cl.preview || "";

  // Campos extra
  const camposExtraHtml = (cl.camposExtra && cl.camposExtra.length > 0)
    ? `<div class="clausula-campos-extra ${incluida ? 'visible' : ''}" id="clausula-extra-0" style="${incluida ? '' : 'display:none;'}">
        <p style="font-size:0.84rem;font-weight:600;color:var(--primary);margin-bottom:10px;">
          Completa los siguientes campos para esta cláusula:
        </p>
        ${cl.camposExtra.map(campo => `
          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">${esc(campo)}</label>
            <input type="text"
                   class="form-input clausula-campo-input"
                   placeholder="${esc(campo)}"
                   data-clausula="${cl.id}"
                   data-campo="${esc(campo)}"
                   value="${esc(camposClausulas[cl.id + '_' + campo] || '')}"
                   oninput="guardarCampoClausulaExtra(this)" />
          </div>`).join("")}
      </div>`
    : "";

  const prevBtn = idx > 0
    ? `<button class="btn-clausula-nav" onclick="mostrarDetalleClausula(${idx - 1})">← Anterior</button>`
    : `<span></span>`;
  const nextBtn = idx < total - 1
    ? `<button class="btn-clausula-nav" onclick="mostrarDetalleClausula(${idx + 1})">Siguiente →</button>`
    : `<span></span>`;

  container.innerHTML = `
    <div class="clausula-detalle-wrap">
      <div class="clausula-detalle-header">
        <button class="clausula-volver-btn" onclick="mostrarListaClausulas()">
          <svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px;vertical-align:-2px;margin-right:5px;">
            <path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd"/>
          </svg>
          Ver todas las cláusulas
        </button>
        <span class="clausula-detalle-progreso">${idx + 1} / ${total}</span>
      </div>

      <div class="clausula-detalle-body">
        <h4 class="clausula-detalle-titulo">${esc(cl.titulo)}</h4>
        ${textoCompleto ? `<div class="clausula-word-viewer"><div class="word-page">${textoPlanoAHtml(textoCompleto)}</div></div>` : ""}
        <div class="clausula-opcion-btns" style="margin-top:18px;">
          <button class="btn-clausula-incluir ${incluida ? 'activo' : ''}" id="det-btn-incluir"
                  onclick="toggleClausulaDesdeDetalle(${idx}, true)">
            ✅ Incluir esta cláusula
          </button>
          <button class="btn-clausula-excluir ${excluida ? 'activo' : ''}" id="det-btn-excluir"
                  onclick="toggleClausulaDesdeDetalle(${idx}, false)">
            ✗ Excluir del contrato
          </button>
        </div>
        ${camposExtraHtml}
      </div>

      <div class="clausula-detalle-nav">
        ${prevBtn}
        ${nextBtn}
      </div>
    </div>`;
}

/* Toggle cláusula desde la vista de detalle */
function toggleClausulaDesdeDetalle(idx, incluir) {
  const cl = minutaClausulas[idx];
  if (!cl) return;
  eleccionesClausulas[cl.id] = incluir;
  // Actualizar botones en detalle
  const btnInc = document.getElementById("det-btn-incluir");
  const btnExc = document.getElementById("det-btn-excluir");
  if (btnInc) btnInc.classList.toggle("activo", incluir);
  if (btnExc) btnExc.classList.toggle("activo", !incluir);
  // Mostrar/ocultar campos extra
  const extraDiv = document.getElementById("clausula-extra-0");
  if (extraDiv) {
    extraDiv.style.display = incluir ? "block" : "none";
  }
  actualizarLivePreview();
}

/* Toggle de elección de cláusula por parte del cliente */
function toggleClausula(idx, incluir) {
  const cl = minutaClausulas[idx];
  if (!cl) return;

  eleccionesClausulas[cl.id] = incluir;

  const card = document.getElementById("clausula-card-" + idx);
  if (card) {
    card.classList.toggle("seleccionada", incluir);
    card.classList.toggle("excluida", !incluir);
    // Ícono del encabezado
    const icono = document.getElementById("clausula-icono-" + idx);
    if (icono) icono.textContent = incluir ? "✅" : "✗";
    // Botones
    const btnInc = card.querySelector(".btn-clausula-incluir");
    const btnExc = card.querySelector(".btn-clausula-excluir");
    if (btnInc) btnInc.classList.toggle("activo", incluir);
    if (btnExc) btnExc.classList.toggle("activo", !incluir);
    // Mostrar/ocultar campos extra
    const extraDiv = document.getElementById("clausula-extra-" + idx);
    if (extraDiv) extraDiv.classList.toggle("visible", incluir);
  }
  actualizarLivePreview();
}

/* Guarda un campo extra de cláusula en la variable global */
function guardarCampoClausulaExtra(input) {
  const clausulaId = input.getAttribute("data-clausula");
  const campo = input.getAttribute("data-campo");
  camposClausulas[clausulaId + "_" + campo] = input.value;
  // Quitar marcado de error si el usuario está escribiendo
  if (input.value.trim()) {
    input.style.borderColor = "";
    input.style.background = "";
  }
}

/* Valida que todas las cláusulas tengan una elección y que los campos extra obligatorios estén llenos.
   Devuelve {ok: true} o {ok: false, razon: "..."} */
function validateClausulas() {
  for (const cl of minutaClausulas) {
    if (eleccionesClausulas[cl.id] === undefined || eleccionesClausulas[cl.id] === null) {
      return { ok: false, razon: `Por favor indica si deseas incluir o excluir la cláusula: "${cl.titulo}".` };
    }
    if (eleccionesClausulas[cl.id] === true && cl.camposExtra && cl.camposExtra.length) {
      for (const campo of cl.camposExtra) {
        const val = (camposClausulas[cl.id + "_" + campo] || "").trim();
        if (!val) return { ok: false, razon: `Completa el campo "${campo}" de la cláusula "${cl.titulo}".` };
      }
    }
  }
  return { ok: true };
}

/* Resalta visualmente los campos extra vacíos de cláusulas incluidas */
function marcarCamposExtraFaltantes() {
  document.querySelectorAll(".clausula-campo-input").forEach(input => {
    const clausulaId = input.getAttribute("data-clausula");
    const campo = input.getAttribute("data-campo");
    const incluida = eleccionesClausulas[clausulaId] === true;
    const vacio = !(camposClausulas[clausulaId + "_" + campo] || "").trim();
    if (incluida && vacio) {
      input.style.borderColor = "var(--danger)";
      input.style.background = "rgba(192,57,43,0.04)";
    } else {
      input.style.borderColor = "";
      input.style.background = "";
    }
  });
}

/* Guarda los valores actuales de los inputs en camposClausulas */
function saveClausulasActuales() {
  const inputs = document.querySelectorAll(".clausula-campo-input");
  inputs.forEach(inp => {
    const clausulaId = inp.getAttribute("data-clausula");
    const campo = inp.getAttribute("data-campo");
    camposClausulas[clausulaId + "_" + campo] = inp.value;
  });
}

/* ══════════════════════════════════════════════════════════
   PROCESAMIENTO DOCX — eliminar cláusulas y renumerar
══════════════════════════════════════════════════════════ */

const ORDINALES_ES = [
  "PRIMERO","SEGUNDO","TERCERO","CUARTO","QUINTO",
  "SEXTO","SÉPTIMO","SÉPTIMO","OCTAVO","NOVENO",
  "DÉCIMO","DÉCIMO PRIMERO","DÉCIMO SEGUNDO","DÉCIMO TERCERO",
  "DÉCIMO CUARTO","DÉCIMO QUINTO","DÉCIMO SEXTO","DÉCIMO SÉPTIMO",
  "DÉCIMO OCTAVO","DÉCIMO NOVENO","VIGÉSIMO"
];

// Versiones sin tilde para matching robusto
const ORDINALES_MATCH = [
  "PRIMERO","SEGUNDO","TERCERO","CUARTO","QUINTO",
  "SEXTO","SEPTIMO","SÉPTIMO","OCTAVO","NOVENO",
  "DECIMO","DÉCIMO","DECIMO PRIMERO","DÉCIMO PRIMERO",
  "DECIMO SEGUNDO","DÉCIMO SEGUNDO","DECIMO TERCERO","DÉCIMO TERCERO",
  "DECIMO CUARTO","DÉCIMO CUARTO","VIGESIMO","VIGÉSIMO"
];

/* Aplica las elecciones del cliente al DOCX:
   - Elimina los párrafos de las cláusulas excluidas (incluidos los marcadores ELECCION USUARIO)
   - Elimina los marcadores ELECCION USUARIO de las cláusulas incluidas
   - Renumera los ordinales españoles
   - Reemplaza los campos extra de cláusulas incluidas */
async function aplicarEleccionesEnDocx(arrayBuffer) {
  if (!minutaClausulas || minutaClausulas.length === 0) return arrayBuffer;

  const zip = new PizZip(arrayBuffer);
  if (!zip.files["word/document.xml"]) return arrayBuffer;

  let xmlText = zip.files["word/document.xml"].asText();

  // Limpiar marcas de Word que parten el texto
  const limpio = xmlText
    .replace(/<w:proofErr[^>]*\/>/g, "")
    .replace(/<w:bookmarkStart[^>]*\/>/g, "")
    .replace(/<w:bookmarkEnd[^>]*\/>/g, "")
    .replace(/<w:rPrChange[^>]*>[\s\S]*?<\/w:rPrChange>/g, "")
    .replace(/<w:pPrChange[^>]*>[\s\S]*?<\/w:pPrChange>/g, "");

  // Dividir en párrafos
  const parrafoRe = /(<w:p[ >][\s\S]*?<\/w:p>)/g;
  const partes = limpio.split(parrafoRe);

  // Construir lista: alternando texto entre párrafos y los párrafos mismos
  // partes = [textoBefore, p1, textoEntre, p2, textoEntre, ...]
  const MARCA = /ELECCION\s*USUARIO/i;

  // Identificar qué párrafos son marca inicio y marca fin
  let parrafosInfo = [];
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    const esParrafo = /<w:p[ >]/.test(parte) && parte.endsWith("</w:p>");
    const texto = esParrafo ? extractTextFromDocxXml(parte).trim() : "";
    parrafosInfo.push({ contenido: parte, esParrafo, texto, esMarkup: esParrafo && MARCA.test(texto) });
  }

  // Asociar cada párrafo a un bloque de cláusula
  // Primero recolectar índices de marcadores
  const marcadores = []; // {idx, tipo: 'inicio'|'fin'}
  for (let i = 0; i < parrafosInfo.length; i++) {
    if (parrafosInfo[i].esMarkup) marcadores.push(i);
  }

  // Emparejar marcadores: 1ro=inicio, 2do=fin, 3ro=inicio, etc.
  const bloques = []; // {clausulaId, inicioIdx, finIdx}
  for (let i = 0; i < marcadores.length - 1; i += 2) {
    const clausulaIdx = Math.floor(i / 2);
    const cl = minutaClausulas[clausulaIdx];
    if (!cl) continue;
    bloques.push({
      clausulaId: cl.id,
      clausulaIdx,
      inicioIdx: marcadores[i],
      finIdx: marcadores[i + 1]
    });
  }

  // Determinar qué índices de parrafosInfo deben ser eliminados
  const eliminar = new Set();
  for (const bloque of bloques) {
    const incluida = eleccionesClausulas[bloque.clausulaId] !== false;
    if (!incluida) {
      // Excluida: eliminar todos los párrafos del bloque (incluyendo los marcadores)
      for (let j = bloque.inicioIdx; j <= bloque.finIdx; j++) {
        eliminar.add(j);
      }
    } else {
      // Incluida: solo eliminar los párrafos marcadores (inicio y fin)
      eliminar.add(bloque.inicioIdx);
      eliminar.add(bloque.finIdx);
    }
  }

  // Reconstruir XML sin los párrafos eliminados
  let xmlFinal = parrafosInfo
    .filter((_, i) => !eliminar.has(i))
    .map(p => p.contenido)
    .join("");

  // Renumerar ordinales españoles en el documento resultante
  xmlFinal = renumerarOrdinalesDocx(xmlFinal);

  zip.file("word/document.xml", xmlFinal);
  return zip.generate({ type: "arraybuffer", compression: "DEFLATE" });
}

/* Renumera los ordinales españoles en el XML del documento.
   Busca "PRIMERO", "SEGUNDO", etc. en el texto de párrafos con formato de cláusula
   o párrafos como "PARAGRAFO PRIMERO:", "PARAGRAFO SEGUNDO:", etc.
   y los reemplaza en orden secuencial. */
function renumerarOrdinalesDocx(xmlText) {
  // Listas de ordinales en orden — masculino y femenino en paralelo
  const LISTA_MASC = [
    "PRIMERO","SEGUNDO","TERCERO","CUARTO","QUINTO",
    "SEXTO","SÉPTIMO","OCTAVO","NOVENO","DÉCIMO",
    "DÉCIMO PRIMERO","DÉCIMO SEGUNDO","DÉCIMO TERCERO",
    "DÉCIMO CUARTO","DÉCIMO QUINTO","DÉCIMO SEXTO",
    "DÉCIMO SÉPTIMO","DÉCIMO OCTAVO","DÉCIMO NOVENO","VIGÉSIMO"
  ];
  const LISTA_FEM = [
    "PRIMERA","SEGUNDA","TERCERA","CUARTA","QUINTA",
    "SEXTA","SÉPTIMA","OCTAVA","NOVENA","DÉCIMA",
    "DÉCIMA PRIMERA","DÉCIMA SEGUNDA","DÉCIMA TERCERA",
    "DÉCIMA CUARTA","DÉCIMA QUINTA","DÉCIMA SEXTA",
    "DÉCIMA SÉPTIMA","DÉCIMA OCTAVA","DÉCIMA NOVENA","VIGÉSIMA"
  ];

  // Regex para un ordinal conocido — acepta masculino O femenino, con o sin tilde
  // Ordenados de mayor a menor longitud para que los compuestos tengan prioridad
  const SIMPLES_MF = "PRIMER[AO]|SEGUND[AO]|TERCER[AO]|CUART[AO]|QUINT[AO]|SEXT[AO]|S[EÉ]PTIM[AO]|OCTAV[AO]|NOVEN[AO]";
  const ORDINAL_RE_STR = "(?:D[EÉ]CIM[AO]\\s+(?:" + SIMPLES_MF + ")|VIG[EÉ]SIM[AO]|D[EÉ]CIM[AO]|" + SIMPLES_MF + ")";

  // Detecta párrafos que:
  //   a) empiezan directamente con el ordinal: "PRIMERA –", "CUARTA –", "DÉCIMA PRIMERA –"
  //   b) empiezan con "PARAGRAFO ORDINAL": "PARAGRAFO PRIMERO:", "PÁRAGRAFO SEGUNDA:"
  const PATRON_TITULO_A = new RegExp("^(" + ORDINAL_RE_STR + ")\\b", "i");
  const PATRON_TITULO_B = new RegExp("^(P[AÁ]RRAFO|PARA[GG]RAFO|P[AÁ]RAGRAFO)\\s+(" + ORDINAL_RE_STR + ")\\b", "i");

  // Determina si un ordinal detectado es femenino
  // Los ordinales femeninos en español terminan en A: PRIMERA, SEGUNDA, DÉCIMA, DÉCIMA PRIMERA, etc.
  function esFemenino(str) {
    return /[aáAÁ]\s*$/.test(str.trim());
  }

  // Dado un índice de posición y el género detectado, devuelve el ordinal correcto
  function ordinalPorPosicion(idx, fem) {
    const lista = fem ? LISTA_FEM : LISTA_MASC;
    return idx < lista.length ? lista[idx] : null;
  }

  // Dividir en párrafos para renumerar solo párrafos de título
  const parrafoRe = /(<w:p[ >][\s\S]*?<\/w:p>)/g;
  const partes = xmlText.split(parrafoRe);

  // Contadores independientes: uno para cláusulas (A) y otro para parágrafos (B)
  let contadorClausulas = 0;
  let contadorParafrafos = 0;
  const WP_START_RE = /<w:p[\s>]/;

  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    if (!WP_START_RE.test(parte) || !parte.endsWith("</w:p>")) continue;

    const textoParrafo = extractTextFromDocxXml(parte).trim();

    // Caso B: párrafo que empieza con PARAGRAFO/PARÁGRAFO + ordinal (comprobar antes del caso A)
    const matchB = textoParrafo.match(PATRON_TITULO_B);
    if (matchB) {
      const ordinalTexto = matchB[2];
      const fem = esFemenino(ordinalTexto);
      const ordinalNuevo = ordinalPorPosicion(contadorParafrafos, fem);
      contadorParafrafos++;
      if (ordinalNuevo && ordinalTexto.trim().toUpperCase() !== ordinalNuevo) {
        partes[i] = reemplazarTextoEnParrafoXml(parte, ordinalTexto, ordinalNuevo);
      }
      continue;
    }

    // Caso A: párrafo que empieza directamente con el ordinal (cláusulas)
    const matchA = textoParrafo.match(PATRON_TITULO_A);
    if (matchA) {
      const ordinalTexto = matchA[1];
      const fem = esFemenino(ordinalTexto);
      const ordinalNuevo = ordinalPorPosicion(contadorClausulas, fem);
      contadorClausulas++;
      if (ordinalNuevo && ordinalTexto.trim().toUpperCase() !== ordinalNuevo) {
        partes[i] = reemplazarTextoEnParrafoXml(parte, ordinalTexto, ordinalNuevo);
      }
      continue;
    }
  }

  return partes.join("");
}

/* Reemplaza un texto específico dentro de los <w:t> de un párrafo Word XML */
function reemplazarTextoEnParrafoXml(parrafoXml, textoViejo, textoNuevo) {
  // Reemplaza todas las ocurrencias del texto viejo en los elementos <w:t>
  const reEscaped = textoViejo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(reEscaped, 'gi');
  return parrafoXml.replace(/<w:t([^>]*)>([\s\S]*?)<\/w:t>/g, (match, attrs, content) => {
    const newContent = content.replace(re, xmlEsc(textoNuevo));
    return `<w:t${attrs}>${newContent}</w:t>`;
  });
}

async function detectarPlaceholdersIA(arrayBuffer) {
  const zip = new PizZip(arrayBuffer);
  const files = ["word/document.xml","word/header1.xml","word/header2.xml","word/footer1.xml","word/footer2.xml"];

  const encontrados = new Map(); // clave normalizada → texto original
  const reDetect = /ESPACIO\s+PARA\s+EL\s+TEXTO\s+DE\s+LA\s+IA\s*(\d+)\s*\(([^)]+)\)/gi;

  files.forEach(f => {
    if (!zip.files[f]) return;
    const xmlText = zip.files[f].asText();

    // Eliminar marcas de Word que parten el texto
    const limpio = xmlText
      .replace(/<w:proofErr[^>]*\/>/g, "")
      .replace(/<w:bookmarkStart[^>]*\/>/g, "")
      .replace(/<w:bookmarkEnd[^>]*\/>/g, "");

    // Estrategia A: buscar en el XML crudo directamente
    let m;
    reDetect.lastIndex = 0;
    while ((m = reDetect.exec(limpio)) !== null) {
      const num   = m[1];
      const label = m[2].trim().toUpperCase();
      const clave = `ESPACIO PARA EL TEXTO DE LA IA${num} (${label})`;
      encontrados.set(clave, clave);
    }

    // Estrategia B: buscar en el texto plano (por si estaba partido entre runs)
    const textoPlano = extractTextFromDocxXml(limpio);
    reDetect.lastIndex = 0;
    while ((m = reDetect.exec(textoPlano)) !== null) {
      const num   = m[1];
      const label = m[2].trim().toUpperCase();
      const clave = `ESPACIO PARA EL TEXTO DE LA IA${num} (${label})`;
      encontrados.set(clave, clave);
    }
  });

  // Devolver ordenados por número
  return [...encontrados.values()].sort((a, b) => {
    const na = parseInt(a.match(/IA(\d+)/)?.[1] || "0");
    const nb = parseInt(b.match(/IA(\d+)/)?.[1] || "0");
    return na - nb;
  });
}

/* Cuando el admin selecciona un archivo */
document.getElementById("adm-archivo").addEventListener("change", async e => {
  const file = e.target.files[0];
  const info = document.getElementById("file-info");
  const aiBox = document.getElementById("ai-question-box");
  const aiResult = document.getElementById("ai-placeholders-result");
  const eleccionBox = document.getElementById("eleccion-question-box");
  const eleccionResult = document.getElementById("eleccion-detected-result");

  adminDocxBuffer = null;
  adminPlaceholdersIA = [];
  adminClausulasEleccion = [];

  if (!file) {
    info.style.display = "none";
    aiBox.style.display = "none";
    eleccionBox.style.display = "none";
    return;
  }
  const kb    = (file.size / 1024).toFixed(1);
  const mb    = (file.size / 1024 / 1024).toFixed(2);
  const sizeStr = file.size > 1024*1024 ? mb + " MB" : kb + " KB";
  info.style.display = "block";
  info.textContent = "📄 " + file.name + "  —  " + sizeStr;

  // Leer el buffer
  try {
    adminDocxBuffer = await file.arrayBuffer();
  } catch(ex) {}

  // Detectar cláusulas ELECCION USUARIO automáticamente
  eleccionResult.style.display = "none";
  eleccionResult.innerHTML = "";
  try {
    const clausulasDetectadas = await detectarClausulasEleccion(adminDocxBuffer);
    if (clausulasDetectadas.length > 0) {
      eleccionBox.style.display = "block";
      // Pre-rellenar los datos detectados
      adminClausulasEleccion = clausulasDetectadas;
    } else {
      eleccionBox.style.display = "block"; // mostrar de todas formas para confirmar
      adminClausulasEleccion = [];
    }
  } catch(ex) {
    eleccionBox.style.display = "block";
  }

  // Mostrar la pregunta de IA
  aiBox.style.display = "block";
  aiResult.style.display = "none";
  aiResult.innerHTML = "";

  // Resetear botones
  const btns = aiBox.querySelectorAll(".ai-question-btns .btn");
  btns.forEach(b => b.classList.remove("btn-success"));
});

async function confirmarCamposIA(tiene) {
  const aiBox    = document.getElementById("ai-question-box");
  const aiResult = document.getElementById("ai-placeholders-result");

  if (!tiene) {
    adminPlaceholdersIA = [];
    aiResult.style.display = "block";
    aiResult.innerHTML = "<p style='color:var(--text-muted);'>Sin campos de IA. La minuta usará solo los campos personalizables normales.</p>";
    return;
  }

  if (!adminDocxBuffer) {
    toast("Primero selecciona un archivo Word.", "error"); return;
  }

  aiResult.style.display = "block";
  aiResult.innerHTML = "<p style='color:var(--text-muted);'>Analizando el documento...</p>";

  try {
    const encontrados = await detectarPlaceholdersIA(adminDocxBuffer);
    adminPlaceholdersIA = encontrados;

    if (!encontrados.length) {
      aiResult.innerHTML = `<p style='color:var(--danger);font-weight:600;'>No se encontraron marcadores de IA en el documento.</p>
        <p style='font-size:0.82rem;color:var(--text-muted);margin-top:6px;'>
          El Word debe contener exactamente los textos:<br>
          <code>ESPACIO PARA EL TEXTO DE LA IA1 (HECHOS)</code><br>
          <code>ESPACIO PARA EL TEXTO DE LA IA2 (PRETENSIONES)</code><br>
          El número y la etiqueta entre paréntesis son obligatorios.
        </p>`;
    } else {
      aiResult.innerHTML = `<p style='color:var(--success);font-weight:600;'>✅ Se detectaron ${encontrados.length} marcador(es) de IA:</p>
        <ul>${encontrados.map(p => `<li><code>${esc(p)}</code> → campo "<strong>${esc(humanizarPlaceholderIA(p))}</strong>"</li>`).join("")}</ul>
        <p style='font-size:0.82rem;color:var(--text-muted);margin-top:8px;'>Estos marcadores serán reemplazados por el texto mejorado por IA al generar el documento.</p>`;
    }
  } catch(ex) {
    aiResult.innerHTML = `<p style='color:var(--danger);'>Error analizando el archivo: ${esc(ex.message)}</p>`;
  }
}

/* Límite en bytes para guardar el docx como Base64 en Firestore.
   Firestore permite ~1 MB por documento; dejamos margen amplio.
   Archivos más grandes se guardan SOLO en Storage (archivoURL). */
const DOCX_BASE64_MAX_BYTES = 700 * 1024; // 700 KB

/* ── FORMULARIO NUEVA MINUTA ── */
document.getElementById("form-nueva-minuta").addEventListener("submit", async e => {
  e.preventDefault();
  if (!isAdmin) { toast("Sin permisos.", "error"); return; }
  const btn = document.getElementById("btn-guardar-minuta");
  btn.disabled = true; btn.textContent = "Guardando...";
  try {
    const nombre        = document.getElementById("adm-nombre").value.trim();
    const descripcion   = document.getElementById("adm-descripcion").value.trim();
    const categoria     = document.getElementById("adm-categoria").value;
    const tipoDocSel    = document.getElementById("adm-tipo-documento");
    const tipoDocumento = tipoDocSel ? tipoDocSel.value.trim() : "";
    const ctxIaEl       = document.getElementById("adm-contexto-ia");
    const contextoIA    = ctxIaEl ? ctxIaEl.value.trim() : "";
    const precio        = parseFloat(document.getElementById("adm-precio").value)||0;
    const campos      = document.getElementById("adm-campos").value.split(",").map(s=>s.trim()).filter(Boolean);
    const camposLargo = document.getElementById("adm-campos-largo-nombres").value.split(",").map(s=>s.trim()).filter(Boolean);
    const file        = document.getElementById("adm-archivo").files[0];
    const filePreview = document.getElementById("adm-archivo-preview").files[0];

    const tieneIA      = adminPlaceholdersIA.length > 0;
    const placeholdersIA = adminPlaceholdersIA;

    // Cláusulas opcionales
    const tieneClausulas = adminClausulasEleccion.length > 0;
    const clausulasEleccion = adminClausulasEleccion;

    let archivoURL = "", archivoNombre = "", docxBase64 = "", docxPreviewURL = "";

    if (file) {
      archivoNombre = file.name;

      // 1. Subir siempre a Storage si está disponible (funciona para cualquier tamaño)
      if (storage) {
        try {
          btn.textContent = "Subiendo archivo de trabajo a Storage...";
          const sRef = storage.ref("minutas/" + Date.now() + "_" + file.name);
          await sRef.put(file);
          archivoURL = await sRef.getDownloadURL();
        } catch(se) {
          console.warn("[Admin] Error subiendo a Storage:", se);
          toast("Advertencia: no se pudo subir a Storage. Verifica las reglas de Firebase Storage.", "error");
        }
      }

      // 2. Guardar Base64 en Firestore SOLO si el archivo es suficientemente pequeño
      //    (como respaldo rápido, evita un fetch adicional al abrir la minuta)
      if (file.size <= DOCX_BASE64_MAX_BYTES) {
        try {
          btn.textContent = "Leyendo archivo de trabajo...";
          docxBase64 = await fileToBase64(file);
        } catch(be) {
          console.warn("[Admin] Error convirtiendo a Base64:", be);
          docxBase64 = "";
        }
      }
      // Si el archivo es grande, docxBase64 queda vacío — se usará archivoURL en su lugar
    }

    if (filePreview) {
      btn.textContent = "Subiendo archivo de previsualización...";
      if (storage) {
        try {
          const sRefPrev = storage.ref("minutas/preview_" + Date.now() + "_" + filePreview.name);
          await sRefPrev.put(filePreview);
          docxPreviewURL = await sRefPrev.getDownloadURL();
        } catch(se) {
          console.warn("[Admin] Error subiendo preview a Storage:", se);
        }
      } else {
        toast("Firebase Storage no está disponible. El archivo de previsualización no se pudo guardar.", "error");
      }
    }

    if (!archivoURL && !docxBase64) {
      toast("Error: el archivo no se pudo guardar en Storage ni localmente. Verifica la configuración de Firebase Storage.", "error");
      return;
    }

    btn.textContent = "Guardando en base de datos...";

    const datosMinuta = {
      nombre, descripcion, categoria, tipoDocumento, contextoIA, precio, campos, camposLargo,
      tieneIA, placeholdersIA,
      tieneClausulas, clausulasEleccion,
      archivoURL, archivoNombre, docxBase64, docxPreviewURL,
      soloStorage: !docxBase64,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    await db.collection("minutas").add(datosMinuta);

    toast("Minuta guardada correctamente.", "ok");
    document.getElementById("form-nueva-minuta").reset();
    document.getElementById("file-info").style.display = "none";
    document.getElementById("ai-question-box").style.display = "none";
    document.getElementById("eleccion-question-box").style.display = "none";
    adminDocxBuffer = null; adminPlaceholdersIA = []; adminClausulasEleccion = [];
    renderAdminData();
  } catch(err) {
    let msg = err.message || "Error desconocido";
    if (msg.includes("quota") || msg.includes("size") || msg.includes("limit") || msg.includes("longer") || msg.includes("bytes")) {
      msg = "El documento supera el límite de Firestore. Asegúrate de que Firebase Storage esté habilitado y las reglas permitan escritura.";
    } else if (msg.includes("permission") || msg.includes("Permission")) {
      msg = "Sin permisos. Verifica las reglas de seguridad de Firebase.";
    } else if (msg.includes("network") || msg.includes("Network")) {
      msg = "Error de red. Verifica tu conexión a internet.";
    }
    toast("Error: " + msg, "error");
  } finally { btn.disabled = false; btn.textContent = "Guardar Minuta"; }
});

/* ── ADMIN DATA ── */
async function renderAdminData() {
  if (!db) return;
  const minutasList = document.getElementById("admin-minutas-list");
  const ventasList  = document.getElementById("admin-ventas-list");
  minutasList.innerHTML = "<p class='text-muted'>Cargando...</p>";
  ventasList.innerHTML  = "<p class='text-muted'>Cargando...</p>";
  try {
    const msnap = await db.collection("minutas").orderBy("createdAt","desc").get();
    adminMinutasAll = msnap.docs.map(d => ({ id: d.id, ...d.data() }));
    adminMinutasPage = 1; renderAdminMinutas();
    const vsnap = await db.collection("ventas").orderBy("createdAt","desc").get();
    adminVentasAll = vsnap.docs.map(d => ({ id: d.id, ...d.data() }));
    adminVentasPage = 1; renderAdminVentas();
  } catch(err) { minutasList.innerHTML = `<p class='text-muted'>Error: ${err.message}</p>`; }
}

function renderAdminMinutas() {
  const minutasList = document.getElementById("admin-minutas-list");
  const pagCont     = document.getElementById("admin-minutas-pagination");
  if (!adminMinutasAll.length) { minutasList.innerHTML = "<p class='text-muted'>No hay minutas.</p>"; pagCont.innerHTML = ""; return; }
  const totalPages = Math.ceil(adminMinutasAll.length / ADMIN_ITEMS_PER_PAGE);
  const start      = (adminMinutasPage - 1) * ADMIN_ITEMS_PER_PAGE;
  const slice      = adminMinutasAll.slice(start, start + ADMIN_ITEMS_PER_PAGE);
  minutasList.innerHTML = slice.map(m => {
    const iaBadge = m.tieneIA ? ` <span style="background:rgba(37,99,168,0.12);color:var(--primary-light);font-size:0.72rem;font-weight:700;padding:2px 7px;border-radius:10px;border:1px solid rgba(37,99,168,0.2);">Redacción IA · ${(m.placeholdersIA||[]).length} espacios</span>` : "";
    return `<div class="admin-item">
      <div>
        <strong>${esc(m.nombre)}</strong><span class="badge-cat">${esc(m.categoria||"")}</span>${iaBadge}
        <br><small>$${Number(m.precio||0).toLocaleString("es-CO")} COP · ${(m.campos||[]).length} campos · ${(m.docxBase64 || m.archivoURL) ? "✅ Plantilla lista" : "❌ Sin plantilla"} · ${(m.docxPreviewURL || m.docxPreviewBase64) ? "✅ Preview" : "⚠️ Sin preview (verán la plantilla)"}</small>
      </div>
      <div class="admin-item-actions">
        <button class="btn btn-sm btn-danger" onclick="eliminarMinuta('${m.id}')">Eliminar</button>
      </div>
    </div>`;
  }).join("");
  renderPagination(pagCont, adminMinutasPage, totalPages, p => { adminMinutasPage = p; renderAdminMinutas(); });
}

function renderAdminVentas() {
  const ventasList = document.getElementById("admin-ventas-list");
  const pagCont    = document.getElementById("admin-ventas-pagination");
  if (!adminVentasAll.length) { ventasList.innerHTML = "<p class='text-muted'>Aún no hay ventas.</p>"; pagCont.innerHTML = ""; return; }
  const totalPages = Math.ceil(adminVentasAll.length / ADMIN_ITEMS_PER_PAGE);
  const start      = (adminVentasPage - 1) * ADMIN_ITEMS_PER_PAGE;
  const slice      = adminVentasAll.slice(start, start + ADMIN_ITEMS_PER_PAGE);
  ventasList.innerHTML = slice.map(v => {
    const estadoClass = v.estado === "pagado" ? "estado-pagado" : "";
    const estadoStyle = v.estado !== "pagado" ? 'style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.78rem;font-weight:600;margin-left:6px;background:#fff3cd;color:#856404;"' : "";
    const estadoLabel = v.estado === "pagado" ? "Pagado" : v.estado === "pendiente" ? "Pendiente" : v.estado || "—";
    const txId = v.transactionId ? ` · TX: ${v.transactionId}` : "";
    return `<div class="admin-item">
      <div>
        <strong>${esc(v.minutaNombre)}</strong>
        <span class="${estadoClass}" ${estadoStyle}>${estadoLabel}</span>
        <br><small>${esc(v.userEmail)} · $${Number(v.precio||0).toLocaleString("es-CO")} COP · ${v.metodoPago||"-"}${txId} · ${v.createdAt && v.createdAt.toDate ? v.createdAt.toDate().toLocaleString("es-CO",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "—"}</small>
      </div>
    </div>`;
  }).join("");
  renderPagination(pagCont, adminVentasPage, totalPages, p => { adminVentasPage = p; renderAdminVentas(); });
}

async function eliminarMinuta(id) {
  if (!confirm("¿Eliminar esta minuta?")) return;
  try {
    await db.collection("minutas").doc(id).delete();
    toast("Minuta eliminada.");
    renderAdminData();
  } catch(e) { toast("Error: " + e.message, "error"); }
}

async function reiniciarVentas() {
  if (!db || !isAdmin) return;
  if (!confirm("¿Estás seguro de que deseas eliminar TODOS los registros de ventas?\n\nEsta acción es permanente e irreversible. Las minutas, categorías y configuración NO se borrarán.")) return;
  if (!confirm("Confirmación final: ¿eliminar todos los registros de compras-ventas?")) return;
  const btn = document.querySelector('[onclick="reiniciarVentas()"]');
  if (btn) { btn.disabled = true; btn.textContent = "Eliminando..."; }
  try {
    const snap = await db.collection("ventas").get();
    if (snap.empty) { toast("No hay registros de ventas para eliminar.", ""); return; }
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    adminVentasAll = [];
    adminVentasPage = 1;
    renderAdminVentas();
    toast(`Se eliminaron ${snap.size} registro(s) de ventas correctamente.`, "ok");
  } catch(e) {
    toast("Error al eliminar ventas: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Reiniciar todo"; }
  }
}

/* ── CARGAR CONFIG WOMPI EN ADMIN ── */
async function cargarWompiConfigAdmin() {
  if (!db) return;
  try {
    const snap = await db.collection("config").doc("wompi").get();
    if (snap.exists) {
      const data = snap.data();
      wompiConfig = data;
      document.getElementById("wompi-public-key").value      = data.publicKey || "";
      document.getElementById("wompi-integrity-secret").value = data.integritySecret || "";
      document.getElementById("wompi-mode").value            = data.mode || "test";
      const statusEl = document.getElementById("wompi-config-status");
      if (data.publicKey) statusEl.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">Wompi configurado en modo ${data.mode === "prod" ? "Producción" : "Pruebas"}.</p>`;
    }
  } catch(_) {}
}

/* ── CARGAR CONFIG OPENAI EN ADMIN (para mostrar estado) ── */
async function cargarGeminiConfigAdmin() {
  if (!db) return;
  try {
    const snap = await db.collection("config").doc("openai").get();
    if (snap.exists) {
      const data = snap.data();
      geminiConfig = data;
      const statusEl = document.getElementById("gemini-config-status");
      if (data.apiKey) {
        const keyMasked = data.apiKey.substring(0, 7) + "..." + data.apiKey.slice(-4);
        statusEl.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ Groq configurado. Clave: ${keyMasked}</p>`;
      }
    }
  } catch(_) {}
}

/* ═══════════════════════════════════════════════════════
   UTILIDADES
═══════════════════════════════════════════════════════ */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function xmlEsc(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

/* Convierte texto (posiblemente con \n) en XML de Word:
   Si tiene saltos de línea, genera múltiples párrafos Word <w:p>.
   Si no, devuelve solo el texto escapado para insertarlo dentro de <w:t>. */
function textoAWordXml(texto, pPr, rPr) {
  const lineas = String(texto).split(/\r?\n/);
  if (lineas.length <= 1) {
    // Sin saltos: retorna solo el texto, se inserta en el <w:t> existente
    return xmlEsc(texto);
  }
  // Con saltos: genera párrafos Word completos
  return lineas.map(linea => {
    const textEsc = xmlEsc(linea);
    return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${textEsc}</w:t></w:r></w:p>`;
  }).join("");
}

/* ── INICIALIZAR ── */
// Restaurar modo prueba si estaba activo en sesión anterior
if (localStorage.getItem("modoPrueba") === "1") { modoPrueba = true; }
loadCategorias();
cargarWompiConfig();
cargarGeminiConfig();
showSection("inicio");
precargarHeroStatusPill();

/* ══════════════════════════════════════════════════════════════════════
   VISTA PREVIA EN VIVO (lado izquierdo del modal de adquisición)
   Convierte el docxBlob a HTML, marca cada placeholder y cláusula,
   y los actualiza en tiempo real conforme el usuario llena el formulario.
══════════════════════════════════════════════════════════════════════ */

let livePreviewReady     = false;
let livePreviewWired     = false;
let _livePreviewInitId   = 0;

function getActualPanelId() {
  try { return getStepPanelId(currentStep); } catch(_) { return null; }
}

function panelUsaLivePreview(panelId) {
  return panelId === 2 || panelId === "clausulas" || panelId === 3;
}

function aplicarClaseLivePreviewSegunPaso() {
  const body  = document.getElementById("modal-body");
  const modal = document.getElementById("modal-compra");
  if (!body || !modal) return;
  const panelId = getActualPanelId();
  const debe = livePreviewReady && panelUsaLivePreview(panelId);
  body.classList.toggle("with-live-preview", debe);
  modal.classList.toggle("modal--with-preview", debe);
  if (!debe) body.classList.remove("lp-mobile-open");
}

function toggleLivePreviewMobile() {
  const body = document.getElementById("modal-body");
  const btn  = document.getElementById("live-preview-toggle-mobile");
  if (!body) return;
  const abierto = body.classList.toggle("lp-mobile-open");
  if (btn) {
    const txt = btn.querySelector(".lp-toggle-text");
    if (txt) txt.textContent = abierto ? "Ocultar vista previa" : "Ver vista previa";
  }
}

/* Convierte texto plano con saltos de línea a HTML escapado */
function _lpEscMultiline(str) {
  return esc(String(str || "")).replace(/\r?\n/g, "<br>");
}

/* Reúne todos los nombres de placeholders posibles del documento */
function _lpRecolectarPlaceholders() {
  const set = new Set();
  if (currentMinuta) {
    (currentMinuta.campos || []).forEach(n => n && set.add(n));
    (currentMinuta.camposLargo || []).forEach(n => n && set.add(n));
  }
  (placeholdersIA || []).forEach(n => n && set.add(n));
  (minutaClausulas || []).forEach(cl => {
    (cl.camposExtra || []).forEach(n => n && set.add(n));
  });
  return Array.from(set).filter(s => String(s).trim().length > 0);
}

/* Recorre los nodos de texto del root y envuelve cada placeholder en un span */
function _lpEnvolverPlaceholdersEnDom(root, nombres) {
  if (!nombres.length) return;
  const lista = nombres.slice().sort((a, b) => b.length - a.length);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (n.parentNode && n.parentNode.classList && n.parentNode.classList.contains("lp-ph")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  textNodes.forEach(node => {
    let txt = node.nodeValue;
    const upper = txt.toUpperCase();
    let alguno = false;
    for (const name of lista) {
      if (upper.indexOf(name.toUpperCase()) !== -1) { alguno = true; break; }
    }
    if (!alguno) return;

    const frag = document.createDocumentFragment();
    let remaining = txt;
    while (remaining.length) {
      const upRem = remaining.toUpperCase();
      let bestIdx = -1, bestName = null;
      for (const name of lista) {
        const idx = upRem.indexOf(name.toUpperCase());
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx || (idx === bestIdx && name.length > bestName.length))) {
          bestIdx = idx; bestName = name;
        }
      }
      if (bestIdx === -1) {
        frag.appendChild(document.createTextNode(remaining));
        break;
      }
      if (bestIdx > 0) frag.appendChild(document.createTextNode(remaining.slice(0, bestIdx)));
      const span = document.createElement("span");
      span.className = "lp-ph";
      span.dataset.ph = bestName;
      span.textContent = bestName;
      frag.appendChild(span);
      remaining = remaining.slice(bestIdx + bestName.length);
    }
    node.parentNode.replaceChild(frag, node);
  });
}

/* Detecta los bloques de cláusula (delimitados por "ELECCION USUARIO") y los envuelve */
function _lpEnvolverClausulasEnDom(root) {
  if (!minutaClausulas || !minutaClausulas.length) return;
  const hijos = Array.from(root.children);
  const marcadores = hijos.filter(el => /ELECCION\s+USUARIO/i.test(el.textContent || ""));
  const pares = Math.floor(marcadores.length / 2);
  for (let i = 0; i < pares; i++) {
    const startEl = marcadores[i * 2];
    const endEl   = marcadores[i * 2 + 1];
    const cl = minutaClausulas[i];
    if (!cl) continue;
    const nodos = [];
    let cur = startEl;
    while (cur) {
      nodos.push(cur);
      if (cur === endEl) break;
      cur = cur.nextElementSibling;
    }
    if (!nodos.length || nodos[nodos.length - 1] !== endEl) continue;

    const wrap = document.createElement("div");
    wrap.className = "lp-clause";
    wrap.dataset.clIdx = String(i);
    wrap.dataset.clId  = cl.id;
    root.insertBefore(wrap, startEl);
    nodos.forEach(node => {
      if (node === startEl || node === endEl) {
        if (node.classList) node.classList.add("lp-clause-marker");
      }
      wrap.appendChild(node);
    });
  }
}

/* Inicializa la previsualización en vivo: convierte el docx a HTML y marca placeholders/cláusulas */
async function inicializarLivePreview() {
  const myId = ++_livePreviewInitId;
  livePreviewReady = false;
  const cont = document.getElementById("live-preview-content");
  if (!cont) return;

  if (!docxBlob) {
    cont.innerHTML = `<div class="live-preview-empty">No fue posible cargar la previsualización del documento.</div>`;
    aplicarClaseLivePreviewSegunPaso();
    return;
  }

  cont.innerHTML = `<div class="live-preview-empty"><div class="loading-spinner" style="margin:0 auto 12px;"></div>Generando previsualización…</div>`;

  let html = "";
  try {
    const buf = await docxBlob.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    html = result.value || "";
  } catch (e) {
    console.warn("[livePreview] Error convirtiendo docx:", e);
    cont.innerHTML = `<div class="live-preview-empty">No se pudo generar la previsualización en vivo.</div>`;
    aplicarClaseLivePreviewSegunPaso();
    return;
  }

  // Otra inicialización empezó en paralelo: abortar esta
  if (myId !== _livePreviewInitId) return;

  if (!html) {
    cont.innerHTML = `<div class="live-preview-empty">El documento no contiene contenido para mostrar.</div>`;
    aplicarClaseLivePreviewSegunPaso();
    return;
  }

  cont.innerHTML = `<div class="word-page" id="live-preview-doc">${html}</div>`;
  const doc = cont.querySelector("#live-preview-doc");
  if (!doc) return;

  // Envolver cláusulas primero (para que los placeholders dentro queden contenidos en .lp-clause)
  _lpEnvolverClausulasEnDom(doc);
  // Envolver placeholders
  _lpEnvolverPlaceholdersEnDom(doc, _lpRecolectarPlaceholders());

  livePreviewReady = true;
  wireLivePreviewInputs();
  protegerLivePreviewAntiCopia();
  aplicarClaseLivePreviewSegunPaso();
  actualizarLivePreview();
}

/* Bloquea copiar, cortar, arrastrar, menú contextual y atajos de teclado en la vista previa.
   Además aplica defensas contra capturas de pantalla (oculta el contenido cuando
   se detecta pérdida de foco, cambio de pestaña o tecla PrintScreen). */
let _lpAntiCopyWired = false;
function protegerLivePreviewAntiCopia() {
  if (_lpAntiCopyWired) return;
  const cont = document.getElementById("live-preview-content");
  if (!cont) return;
  _lpAntiCopyWired = true;

  const stop = e => { e.preventDefault(); e.stopPropagation(); return false; };

  // 1) Bloqueo de copia / arrastre / menú contextual
  ["copy","cut","paste","contextmenu","selectstart","dragstart","drop"].forEach(ev => {
    cont.addEventListener(ev, stop);
  });

  // 2) Bloqueo de atajos: Ctrl/Cmd + C/X/A/S/P/U
  cont.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && ["c","x","a","s","p","u"].includes((e.key||"").toLowerCase())) {
      stop(e);
    }
  });

  // 3) Defensas anti-captura — modo agresivo
  const BLACKOUT_MS = 5000;            // duración por defecto del apagón
  const blackoutOn = () => cont.classList.add("lp-blackout");
  const blackoutOff = () => cont.classList.remove("lp-blackout");
  const blackoutTemporal = (ms = BLACKOUT_MS) => {
    blackoutOn();
    clearTimeout(cont._lpBlackoutTimer);
    cont._lpBlackoutTimer = setTimeout(blackoutOff, ms);
  };

  // Helper: verifica que el modal de previsualización esté visible.
  // Si no lo está, no queremos disparar el blackout (sería trabajo en vano
  // y además impediría limpiar focos de otros inputs de la página).
  const previewActivo = () => {
    const modal = document.getElementById("modal-overlay");
    return modal && modal.classList.contains("open");
  };

  // 3a) Pestaña/ventana oculta → ocultar previsualización
  document.addEventListener("visibilitychange", () => {
    if (!previewActivo()) return;
    if (document.hidden) blackoutOn();
    else blackoutTemporal(800); // pequeño retraso al volver, por si fue captura
  });

  // 3b) La ventana pierde el foco (la herramienta de recortes la roba).
  //     IMPORTANTE: SIN capture=true. Con capture activo, cualquier
  //     elemento interno (un input, un botón) que pierda el foco también
  //     disparaba el blackout — por eso "saltaba" al hacer clic en un campo.
  //     Aquí escuchamos solo el blur real de la ventana.
  window.addEventListener("blur", () => {
    if (previewActivo()) blackoutOn();
  });
  window.addEventListener("focus", () => {
    if (previewActivo()) blackoutTemporal(600);
  });

  // 3c) Detección PROACTIVA en keydown — apagamos antes de
  //     que el sistema operativo pueda capturar el área.
  const isCaptureCombo = e => {
    const k = (e.key || "").toLowerCase();
    const code = e.code || "";

    // Tecla Print Screen sola
    if (k === "printscreen" || code === "PrintScreen" || /print/i.test(code)) return true;

    // Algunos navegadores entregan "Snapshot" en lugar de PrintScreen
    if (k === "snapshot") return true;

    // Tecla Windows pulsada explícitamente (sin combinarla con texto):
    // las herramientas de captura del SO se activan así (Win+Shift+S, Win+G).
    // Solo bloqueamos cuando la combinación incluye Shift, G, R, S o números —
    // para no bloquear el uso normal de Cmd/Win en el resto del navegador.
    const winLikeKey =
      code === "MetaLeft" || code === "MetaRight" ||
      code === "OSLeft"   || code === "OSRight"   ||
      k === "meta" || k === "os";
    if (winLikeKey) return true;

    // Win/Cmd + (Shift, G, S, R, 3, 4, 5, 6) — combos típicos de captura
    if ((e.metaKey || (e.getModifierState && e.getModifierState("OS"))) &&
        (e.shiftKey || ["g","s","r","3","4","5","6"].includes(k))) return true;

    return false;
  };

  const onAnyKey = e => {
    if (!previewActivo()) return;
    if (isCaptureCombo(e)) {
      blackoutTemporal(BLACKOUT_MS);
      try { navigator.clipboard && navigator.clipboard.writeText(""); } catch(_) {}
    }
  };
  document.addEventListener("keydown", onAnyKey, true);
  document.addEventListener("keyup", onAnyKey, true);

  // 3d) Si el ratón sale por el BORDE SUPERIOR de la ventana (hacia la
  //     barra de tareas / barra del navegador, donde se inicia la
  //     herramienta de recortes), apagamos preventivamente.
  //     Antes se disparaba con cualquier mouseleave del documento, lo que
  //     causaba parpadeos al moverse al sidebar/scroll.
  document.addEventListener("mouseleave", e => {
    if (!previewActivo()) return;
    // clientY <= 0 → el cursor salió por arriba de la ventana
    if (typeof e.clientY === "number" && e.clientY <= 0) blackoutOn();
  });
  document.addEventListener("mouseenter", () => {
    if (previewActivo()) blackoutTemporal(400);
  });
}

/* Refresca el contenido de cada placeholder y el estado de cada cláusula */
function actualizarLivePreview() {
  if (!livePreviewReady) return;
  const cont = document.getElementById("live-preview-content");
  if (!cont) return;
  const doc = cont.querySelector("#live-preview-doc");
  if (!doc) return;

  // Estado de cláusulas
  doc.querySelectorAll(".lp-clause").forEach(clEl => {
    const id = clEl.dataset.clId;
    const sel = eleccionesClausulas[id];
    clEl.classList.remove("included", "excluded");
    if (sel === false) clEl.classList.add("excluded");
    else if (sel === true) clEl.classList.add("included");
  });

  // Placeholders
  doc.querySelectorAll(".lp-ph").forEach(span => {
    const name = span.dataset.ph;
    let valor = "";

    // 1) Campo normal o campo largo
    if (camposLlenados[name] !== undefined && String(camposLlenados[name]).trim() !== "") {
      valor = camposLlenados[name];
    }
    // 2) Placeholder de IA: prefiere el mejorado, si no el crudo
    else if (placeholdersIA && placeholdersIA.indexOf(name) !== -1) {
      if (camposIAMejorados[name] && String(camposIAMejorados[name]).trim() !== "") valor = camposIAMejorados[name];
      else if (camposIALlenados[name] && String(camposIALlenados[name]).trim() !== "") valor = camposIALlenados[name];
    }
    // 3) Campo extra de cláusula (busca el contenedor de cláusula padre)
    if (!valor) {
      const parentCl = span.closest(".lp-clause");
      if (parentCl) {
        const clId = parentCl.dataset.clId;
        const k = clId + "_" + name;
        if (camposClausulas[k] && String(camposClausulas[k]).trim() !== "") valor = camposClausulas[k];
      }
    }

    if (valor && String(valor).trim() !== "") {
      const nuevoHtml = _lpEscMultiline(valor);
      if (span.innerHTML !== nuevoHtml) {
        span.innerHTML = nuevoHtml;
      }
      if (!span.classList.contains("filled")) span.classList.add("filled");
    } else {
      if (span.textContent !== name) span.textContent = name;
      span.classList.remove("filled");
    }
  });
}

/* Engancha un listener delegado en el modal-body para refrescar la previsualización
   al escribir y para hacer auto-scroll al placeholder del campo en edición. */
function wireLivePreviewInputs() {
  if (livePreviewWired) return;
  const body = document.getElementById("modal-body");
  if (!body) return;
  livePreviewWired = true;

  // Devuelve el nombre del placeholder asociado al input/textarea (o null)
  function placeholderForTarget(t) {
    if (!t || !t.classList) return null;
    if (t.classList.contains("campo-input"))         return t.dataset.campo || null;
    if (t.classList.contains("campo-ia-input"))      return t.dataset.placeholder || null;
    if (t.classList.contains("ia-chat-input"))       return t.dataset.placeholder || null;
    if (t.classList.contains("clausula-campo-input")) return t.dataset.campo || null;
    return null;
  }

  // Hace scroll en la vista previa hasta el span del placeholder y lo resalta
  let _scrollDebounce = null;
  function scrollPreviewToPlaceholder(name) {
    if (!name) return;
    const cont = document.getElementById("live-preview-content");
    if (!cont) return;
    let span = null;
    try {
      span = cont.querySelector(`.lp-ph[data-ph="${CSS.escape(name)}"]`);
    } catch(_) {
      // CSS.escape puede fallar en contextos antiguos; búsqueda manual
      const all = cont.querySelectorAll(".lp-ph");
      for (const el of all) { if (el.dataset.ph === name) { span = el; break; } }
    }
    if (!span) return;

    // Calcular destino para centrar el span dentro del contenedor scrollable
    const contRect = cont.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    const offset   = (spanRect.top - contRect.top) - (cont.clientHeight / 3);
    const target   = Math.max(0, cont.scrollTop + offset);
    cont.scrollTo({ top: target, behavior: "smooth" });

    // Resaltado visual breve
    cont.querySelectorAll(".lp-ph.lp-focus").forEach(s => {
      if (s !== span) s.classList.remove("lp-focus");
    });
    span.classList.add("lp-focus");
  }

  function scheduleScroll(name) {
    if (!name || !livePreviewReady) return;
    if (_scrollDebounce) clearTimeout(_scrollDebounce);
    _scrollDebounce = setTimeout(() => scrollPreviewToPlaceholder(name), 60);
  }

  // input: actualiza el modelo y refresca la previsualización
  body.addEventListener("input", e => {
    const t = e.target;
    if (!t || !t.classList) return;
    let cambio = false;

    if (t.classList.contains("campo-input")) {
      const k = t.dataset.campo;
      if (k) { camposLlenados[k] = t.value; cambio = true; }
    } else if (t.classList.contains("campo-ia-input")) {
      const k = t.dataset.placeholder;
      if (k) {
        camposIALlenados[k] = t.value;
        if (camposIAMejorados[k]) delete camposIAMejorados[k];
        cambio = true;
      }
    } else if (t.classList.contains("clausula-campo-input")) {
      // El handler inline ya guarda en camposClausulas; solo refrescamos
      cambio = true;
    }
    // Para el chat IA NO actualizamos camposIALlenados aquí (eso ocurre al "Enviar"),
    // pero sí queremos que la vista previa se desplace al placeholder activo.

    if (cambio) actualizarLivePreview();
    scheduleScroll(placeholderForTarget(t));
  });

  // focusin: al enfocar un campo, también desplazamos la vista previa al placeholder
  body.addEventListener("focusin", e => {
    scheduleScroll(placeholderForTarget(e.target));
  });

  // click directo sobre el botón "Siguiente página" o cambios de paso/página
  body.addEventListener("click", e => {
    const t = e.target;
    if (!t || !t.closest) return;
    // Si el usuario hace clic dentro de un input, ya lo cubre focusin
    const navBtn = t.closest("#btn-campos-next, #btn-campos-prev");
    if (navBtn) {
      // Tras el cambio de página, enfocar el primer input visible y desplazar la vista
      setTimeout(() => {
        const firstInp = document.querySelector("#campos-dinamicos .campo-input");
        if (firstInp) {
          try { firstInp.focus({ preventScroll: true }); } catch(_) { try { firstInp.focus(); } catch(__) {} }
          scheduleScroll(placeholderForTarget(firstInp));
        }
      }, 80);
    }
  });
}
