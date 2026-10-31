/* ==========================================================
   PENGATURAN — ubah di sini saja
   ========================================================== */
const CONFIG = {
    // Animasi pembuka saat mesin dinyalakan
    showIntro: true,
    ownerName: 'Mr. McElwee',   // nama yang tampil setelah "Welcome,"
    introDuration: 3000,        // ms

    // Suara peringatan seatbelt. Tidak ada file suara di paket ini.
    // Taruh file suara Anda di folder yang sama dengan index.html dengan nama di bawah ini
    // (atau ganti namanya di sini). Kosongkan ('') jika tidak ingin memakai suara.
    seatbeltSound: 'speedometer_sound.mp3',
    seatbeltVolume: 0.8,

    // true  = kedip merah dan suara hanya aktif kalau mesin hidup
    // false = aktif terus selama seatbelt belum dipakai
    warnOnlyWhenEngineOn: true,

    gearCount: 7,            // gear maju tertinggi yang ditampilkan (0 sampai 7)
    zeroGearLabel: 'N',      // tampilan gear 0 (netral/mundur), contoh: 'N' atau 'R'
    rpmScaleMax: 9,          // dipakai untuk membaca RPM asli (x1000)
    redline: 0.8,            // batas zona merah RPM (0 sampai 1)
    lowFuel: 0.2,            // di bawah ini bar fuel jadi merah
    lowHealth: 0.3,          // di bawah ini bar health jadi merah
    startupSweep: true,      // lampu RPM menyapu penuh setelah animasi pembuka
    odometerUnit: 'mi',      // 'mi' atau 'km' (input setOdometer tetap dalam mil)

    // Format input setRPM: 'auto' = nilai 0 sampai 1 dibaca apa adanya, nilai di atas 1.5
    // dianggap RPM asli (misal 2500) dan dibagi (rpmScaleMax x 1000). Bisa juga 'normalized' atau 'raw'.
    rpmInput: 'auto',

    // true = selalu tampilkan panel debug. Di FiveM cukup tambahkan ?debug di akhir URL.
    debug: false
};

/* ========================================================== */

const SCALES = {
    0: { max: 400, factor: 3.6,      unit: 'km/h' },
    1: { max: 250, factor: 2.236936, unit: 'mph' },
    2: { max: 215, factor: 1.943844, unit: 'knots' }
};

const SHIFT_COUNT = 18;
const SPD_COUNT = 40;
const BAR_COUNT = 8;

// Semua nilai terakhir dari server disimpan di sini, lalu ditampilkan oleh fungsi render.
const data = {
    engine: false,
    seatbelts: false,
    speed: 0,          // m/s
    speedMode: 1,      // 0: KMH, 1: MPH, 2: Knots
    rpm: 0,            // 0 sampai 1
    fuel: 1,
    health: 1,
    gear: 0,
    lights: 0,         // 0: off, 1: on, 2: high beam
    odometer: 0        // mil
};

let ready = false;
let el = {};
let shiftSegs = [];
let spdSegs = [];
let fuelSegs = [];
let healthSegs = [];
let sweepValue = 0;
let introTimer = null;
const errors = [];

const clamp01 = n => Math.min(1, Math.max(0, Number(n) || 0));

// Menerima true/false, 1/0, dan teks "true"/"false"/"1"/"0" supaya tidak salah baca.
function toBool(v) {
    if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        return !(t === '' || t === 'false' || t === '0' || t === 'off' || t === 'null' || t === 'undefined');
    }
    return !!v;
}

function logError(e) {
    const msg = e && e.message ? e.message : String(e);
    errors.push(msg);
    if (errors.length > 5) errors.shift();
    if (window.console) console.error('[speedometer]', e);
}

/* ---------- Suara seatbelt ---------- */

let audio = null;
let audioFailed = false;
let lastPlayTry = 0;

function initAudio() {
    if (!CONFIG.seatbeltSound) return;
    try {
        audio = new Audio();
        audio.loop = true;
        audio.volume = CONFIG.seatbeltVolume;
        audio.preload = 'auto';
        audio.addEventListener('error', () => { audioFailed = true; });
        audio.src = CONFIG.seatbeltSound;
    } catch (e) {
        audio = null;
        logError(e);
    }
}

function setAlarm(on) {
    if (!audio || audioFailed) return;

    if (on) {
        if (!audio.paused) return;
        const now = Date.now();
        if (now - lastPlayTry < 800) return;      // jangan mencoba terus-menerus
        lastPlayTry = now;
        const p = audio.play();
        if (p && p.catch) p.catch(() => {});
    } else if (!audio.paused) {
        audio.pause();
        audio.currentTime = 0;
    }
}

/* ---------- Fungsi render (menampilkan data ke layar) ---------- */

function setLit(list, count, hotFrom) {
    for (let i = 0; i < list.length; i++) {
        const lit = i < count;
        const seg = list[i];
        if (seg._lit !== lit) {
            seg._lit = lit;
            seg.classList.toggle('lit', lit);
        }
        if (hotFrom !== undefined) {
            const hot = i >= hotFrom;
            if (seg._hot !== hot) {
                seg._hot = hot;
                seg.classList.toggle('hot', hot);
            }
        }
    }
}

function renderEngine() {
    if (!ready) return;
    el.hud.classList.toggle('engine-off', !data.engine);
    el.engine.classList.toggle('on', data.engine);
}

function renderSeatbelt() {
    if (!ready) return;

    const warnNow = !data.seatbelts && (!CONFIG.warnOnlyWhenEngineOn || data.engine);

    el.seatbelts.classList.toggle('ok', data.seatbelts);
    el.seatbelts.classList.toggle('bad', warnNow);
    el.seatbelts.classList.toggle('warn', !data.seatbelts && !warnNow);
    el.hud.classList.toggle('no-belt', warnNow);
    setAlarm(warnNow);
}

function renderSpeed() {
    if (!ready) return;
    const sc = SCALES[data.speedMode] || SCALES[1];
    const value = data.speed * sc.factor;

    el.speed.textContent = Math.round(value);
    el.speedUnit.textContent = sc.unit;

    const frac = clamp01(value / sc.max);
    setLit(spdSegs, Math.round(frac * SPD_COUNT));
}

function renderRpm() {
    if (!ready) return;
    // Saat animasi sapuan, tampilkan yang lebih tinggi antara RPM asli dan sapuan,
    // jadi nilai asli tidak pernah tertutup.
    const shown = Math.max(data.rpm, sweepValue);
    setLit(shiftSegs, Math.round(shown * SHIFT_COUNT), Math.floor(CONFIG.redline * SHIFT_COUNT));
    el.hud.classList.toggle('redline', data.engine && data.rpm >= CONFIG.redline);
}

function renderMeter(segs, valueEl, meterEl, value, lowLimit) {
    const v = clamp01(value);
    const lit = v <= 0 ? 0 : Math.max(1, Math.round(v * BAR_COUNT));
    setLit(segs, lit);
    valueEl.textContent = `${Math.round(v * 100)}%`;
    meterEl.classList.toggle('low', v <= lowLimit);
}

function renderFuel() {
    if (ready) renderMeter(fuelSegs, el.fuel, el.fuelMeter, data.fuel, CONFIG.lowFuel);
}

function renderHealth() {
    if (ready) renderMeter(healthSegs, el.health, el.healthMeter, data.health, CONFIG.lowHealth);
}

function renderGear() {
    if (!ready) return;
    const n = Math.min(CONFIG.gearCount, Math.max(0, Math.floor(Number(data.gear) || 0)));
    const label = n === 0 ? CONFIG.zeroGearLabel : String(n);

    if (el.gear.textContent !== label) {
        el.gear.textContent = label;
        el.gear.classList.remove('pop');
        void el.gear.offsetWidth;
        el.gear.classList.add('pop');
    }
}

function renderLights() {
    if (!ready) return;
    el.headlights.classList.toggle('on', data.lights === 1);
    el.headlights.classList.toggle('high', data.lights === 2);
}

function renderOdometer() {
    if (!ready) return;
    const km = CONFIG.odometerUnit === 'km';
    const value = km ? data.odometer * 1.609344 : data.odometer;

    el.odometer.textContent = String(Math.floor(value)).padStart(7, '0');
    el.odoUnit.textContent = km ? 'km' : 'mi';
}

function renderAll() {
    renderEngine();
    renderSeatbelt();
    renderSpeed();
    renderRpm();
    renderFuel();
    renderHealth();
    renderGear();
    renderLights();
    renderOdometer();
}

/* ---------- Animasi pembuka dan sapuan lampu RPM ---------- */

function sweepShift() {
    if (!CONFIG.startupSweep) return;

    const duration = 1100;
    const start = Date.now();

    function step() {
        const t = (Date.now() - start) / duration;
        if (t >= 1) {
            sweepValue = 0;
            renderRpm();
            return;
        }
        sweepValue = t < 0.5 ? t * 2 : (1 - t) * 2;
        renderRpm();
        requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function playIntro() {
    clearTimeout(introTimer);

    if (!CONFIG.showIntro) {
        sweepShift();
        return;
    }

    el.hud.classList.add('intro-on');
    introTimer = setTimeout(() => {
        el.hud.classList.remove('intro-on');
        sweepShift();
    }, CONFIG.introDuration);
}

function stopIntro() {
    clearTimeout(introTimer);
    if (el.hud) el.hud.classList.remove('intro-on');
    sweepValue = 0;
}

/* ---------- Fungsi publik (sama seperti template asli) ---------- */

/**
 * @param {boolean} state - true jika mesin hidup.
 */
function setEngine(on) {
    const was = data.engine;
    data.engine = toBool(on);

    if (ready) {
        if (data.engine && !was) playIntro();
        if (!data.engine && was) stopIntro();
    }

    renderEngine();
    renderSeatbelt();
    renderRpm();
}

/**
 * @param {number} speed - Kecepatan dalam meter per detik (m/s).
 */
function setSpeed(speed) {
    data.speed = Number(speed) || 0;
    renderSpeed();
}

/**
 * @param {number} rpm - Nilai RPM dari 0 sampai 1.
 */
function setRPM(rpm) {
    const n = Number(rpm) || 0;
    const raw = CONFIG.rpmInput === 'raw' || (CONFIG.rpmInput === 'auto' && n > 1.5);
    data.rpm = clamp01(raw ? n / (CONFIG.rpmScaleMax * 1000) : n);
    renderRpm();
}

/**
 * @param {number} fuel - Level bensin dari 0 sampai 1.
 */
function setFuel(fuel) {
    data.fuel = fuel;
    renderFuel();
}

/**
 * @param {number} health - Kondisi kendaraan dari 0 sampai 1.
 */
function setHealth(health) {
    data.health = health;
    renderHealth();
}

/**
 * @param {number|string} gear - Gear saat ini (0 sampai 7). 0 dianggap netral/mundur.
 */
function setGear(gear) {
    data.gear = gear;
    renderGear();
}

/**
 * @param {number} state - 0: Off, 1: On, 2: High Beam.
 */
function setHeadlights(level) {
    data.lights = Number(level) || 0;
    renderLights();
}

/**
 * Sein dan kunci sudah dihapus dari tampilan. Dua fungsi ini sengaja dibiarkan kosong
 * supaya server yang masih memanggilnya tidak menimbulkan error.
 */
function setLeftIndicator() {}
function setRightIndicator() {}

/**
 * @param {boolean} state - true jika seatbelt dipakai.
 */
function setSeatbelts(on) {
    data.seatbelts = toBool(on);
    renderSeatbelt();
}

/**
 * @param {number} mode - 0: KMH, 1: MPH, 2: Knots.
 */
function setSpeedMode(mode) {
    data.speedMode = SCALES[mode] ? Number(mode) : 1;
    renderSpeed();
}

/**
 * @param {number} distance - Jarak dalam mil.
 */
function setOdometer(distance) {
    data.odometer = Math.max(0, Number(distance) || 0);
    renderOdometer();
}

/**
 * Tambahan: tampilkan atau sembunyikan seluruh HUD (suara ikut berhenti saat disembunyikan).
 * @param {boolean} visible
 */
function setVisible(visible) {
    visible = toBool(visible);
    if (ready) el.hud.classList.toggle('hidden', !visible);
    if (!visible) setAlarm(false);
    else renderSeatbelt();
}

/* ---------- Membuat segmen ---------- */

function makeSegs(container, count, colorOf) {
    const list = [];
    const frag = document.createDocumentFragment();

    for (let i = 0; i < count; i++) {
        const seg = document.createElement('i');
        if (colorOf) seg.style.setProperty('--c', colorOf(i / (count - 1)));
        frag.appendChild(seg);
        list.push(seg);
    }
    container.appendChild(frag);
    return list;
}

// biru muda -> biru -> violet -> pink -> merah
function shiftColor(t) {
    const hue = t < 0.8 ? 195 + 105 * (t / 0.8) : 300 + 50 * ((t - 0.8) / 0.2);
    return `hsl(${hue.toFixed(0)}, 100%, 64%)`;
}

// biru muda -> biru -> violet -> pink
function speedColor(t) {
    return `hsl(${(195 + 125 * t).toFixed(0)}, 100%, 66%)`;
}

/* ---------- Pesan dari server (opsional) dan panel debug ---------- */

const API_NAMES = ['setEngine', 'setSpeed', 'setRPM', 'setFuel', 'setHealth', 'setGear',
    'setHeadlights', 'setLeftIndicator', 'setRightIndicator', 'setSeatbelts',
    'setSpeedMode', 'setOdometer', 'setVisible'];

// Setiap fungsi dibungkus supaya satu error tidak mematikan fungsi lainnya.
API_NAMES.forEach(name => {
    const original = window[name];
    window[name] = function () {
        try {
            return original.apply(this, arguments);
        } catch (e) {
            logError(e);
        }
    };
});

// Jika server mengirim lewat postMessage, contoh: { action: 'setSpeed', value: 25 }
window.addEventListener('message', ev => {
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    const name = d.action || d.type || d.fn || d.name;
    if (!API_NAMES.includes(name) || typeof window[name] !== 'function') return;
    const args = Array.isArray(d.args) ? d.args : [d.value !== undefined ? d.value : (d.state !== undefined ? d.state : d.data)];
    window[name].apply(window, args);
});

function installDebug() {
    const log = {};
    const messages = [];

    const panel = document.createElement('pre');
    panel.style.cssText = 'position:fixed;top:8px;left:8px;margin:0;padding:8px 10px;z-index:9999;' +
        'background:rgba(0,0,0,.78);color:#8ff0a4;font:12px/1.35 Consolas,monospace;border-radius:6px;' +
        'pointer-events:none;max-width:420px;white-space:pre-wrap';
    document.body.appendChild(panel);

    let queued = false;
    const render = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            const rows = API_NAMES.map(n => {
                const e = log[n];
                return e ? `${n.padEnd(18)} ${e.args.map(a => JSON.stringify(a)).join(', ')}  x${e.count}`
                         : `${n.padEnd(18)} (belum dipanggil)`;
            });
            const sound = !CONFIG.seatbeltSound ? 'nonaktif' : (audioFailed ? 'file tidak ditemukan' : 'siap');
            panel.textContent = 'DEBUG\n' + rows.join('\n') +
                `\n\nsuara seatbelt: ${sound}` +
                (messages.length ? '\n\nMESSAGE:\n' + messages.join('\n') : '') +
                (errors.length ? '\n\nERROR:\n' + errors.slice(-3).join('\n') : '');
        });
    };

    API_NAMES.forEach(name => {
        const wrapped = window[name];
        window[name] = function () {
            const args = Array.prototype.slice.call(arguments);
            const e = log[name] || (log[name] = { args: args, count: 0 });
            e.args = args;
            e.count++;
            render();
            return wrapped.apply(this, args);
        };
    });

    window.addEventListener('error', ev => { errors.push(ev.message); render(); });
    window.addEventListener('message', ev => {
        let text;
        try { text = JSON.stringify(ev.data); } catch (e) { text = String(ev.data); }
        messages.push(text.slice(0, 110));
        if (messages.length > 4) messages.shift();
        render();
    });
    setInterval(render, 1000);
    render();
}

/* ---------- Inisialisasi ---------- */

function init() {
    if (ready) return;

    el = {
        hud: document.getElementById('hud'),
        engine: document.getElementById('engine'),
        seatbelts: document.getElementById('seatbelts'),
        headlights: document.getElementById('headlights'),
        speed: document.getElementById('speed'),
        speedUnit: document.getElementById('speedUnit'),
        gear: document.getElementById('gear'),
        odometer: document.getElementById('odometer'),
        odoUnit: document.getElementById('odoUnit'),
        fuel: document.getElementById('fuel'),
        fuelMeter: document.getElementById('fuelMeter'),
        health: document.getElementById('health'),
        healthMeter: document.getElementById('healthMeter')
    };

    document.getElementById('owner').textContent = CONFIG.ownerName;

    shiftSegs = makeSegs(document.getElementById('shift'), SHIFT_COUNT, shiftColor);
    spdSegs = makeSegs(document.getElementById('spdBar'), SPD_COUNT, speedColor);
    fuelSegs = makeSegs(document.getElementById('fuelBar'), BAR_COUNT);
    healthSegs = makeSegs(document.getElementById('healthBar'), BAR_COUNT);

    initAudio();

    ready = true;
    renderAll();      // menampilkan data yang sudah diterima sebelum halaman siap

    if (CONFIG.debug || /[?&]debug\b/.test(location.search)) installDebug();
}

// Script ada di akhir body, jadi elemen sudah tersedia dan bisa langsung dipakai.
if (document.getElementById('hud')) {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init);
}
