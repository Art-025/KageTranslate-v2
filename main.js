// ======================================
// KONSTANTALAR VA SOZLAMALAR
// ======================================

const CONFIG = {
    TRANSLATE_MAX_RETRIES: 3,
    TRANSLATE_RETRY_DELAY_MS: 800,
    FETCH_TIMEOUT_MS: 5000,
    MAX_CACHE_SIZE: 100,
    PDF_SCALE: 2.5, // OCR va sifat oshirildi
    BATCH_SIZE: 5   // Parallel tarjima limiti
};

// Global holat
let state = {
    sourceLang: "en",
    targetLang: "uz",
    fontFamily: "manga",
    files: [],
    isProcessing: false,
    translationCache: new Map(),
    ocrWorkerPool: [],
    ocrWorkerLang: null,
    abortController: null,
    // Har bir sahifa/rasm uchun ASL piksel koordinatalaridagi ma'lumot -
    // PDF eksport shundan foydalanadi, DOM/CSS o'lchamlariga bog'liq emas
    // (bu orqali ko'p-sahifali PDF'larda scale xatosi butunlay oldini oladi)
    pageRenderData: [],
    // Foydalanuvchi lug'ati: { "Naruto": "Naruto", "Shadow Clone": "Kage Bunshin" }
    // Tarjimadan oldin shu atamalar "niqoblanadi" (API ularni buzmasin uchun),
    // tarjimadan keyin aniq matn bilan qayta tiklanadi.
    userGlossary: {}
};

// DOM Elementlari
const DOM = {
    app: document.getElementById("app"),
    pdfInput: document.getElementById("pdfInput"),
    goBtn: document.getElementById("goBtn"),
    statusText: document.getElementById("statusText"),
    loadingSpinner: document.getElementById("loadingSpinner"),
    progressBar: document.getElementById("progressBar"),
    previewArea: document.getElementById("previewArea"),
    pageContainer: document.getElementById("pageContainer"),
    pdfPreview: document.getElementById("pdfPreview"),
    ocrLayer: document.getElementById("ocrLayer"),
    results: document.getElementById("results"),
    downloadPdfBtn: document.getElementById("downloadPdfBtn"),
    downloadBtn: document.getElementById("downloadBtn"),
    shareBtn: document.getElementById("shareBtn"),
    toast: document.getElementById("toast"),
    overlay: document.getElementById("overlay"),
    errorModal: document.getElementById("errorModal"),
    errorMessage: document.getElementById("errorMessage"),
    confirmModal: document.getElementById("confirmModal"),
    confirmMessage: document.getElementById("confirmMessage"),
    confirmYes: document.getElementById("confirmYes"),
    confirmNo: document.getElementById("confirmNo"),
    processingCanvas: document.getElementById("processingCanvas"),
    bubbleCanvas: document.getElementById("bubbleCanvas"),
    glossaryInput: document.getElementById("glossaryInput"),
    glossaryApplyBtn: document.getElementById("glossaryApplyBtn"),
    customFontInput: document.getElementById("customFontInput")
};

// ======================================
// YORDAMCHI FUNKSIYALAR & SECURITY
// ======================================

function showToast(message) {
    if (!DOM.toast) return;
    DOM.toast.textContent = message;
    DOM.toast.classList.remove("hidden");
    setTimeout(() => DOM.toast.classList.add("hidden"), 3000);
}

function showError(message) {
    if (DOM.errorMessage && DOM.errorModal && DOM.overlay) {
        DOM.errorMessage.textContent = message;
        DOM.errorModal.classList.remove("hidden");
        DOM.overlay.classList.remove("hidden");
    } else {
        alert(message);
    }
}

function closeErrorModal() {
    if (DOM.errorModal) DOM.errorModal.classList.add("hidden");
    if (DOM.overlay) DOM.overlay.classList.add("hidden");
}

function setStatus(text) {
    if (DOM.statusText) DOM.statusText.textContent = text;
}

function updateProgress(percent) {
    if (!DOM.progressBar) return;
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    DOM.progressBar.style.width = `${clamped}%`;
    DOM.progressBar.textContent = `${clamped}%`;
    DOM.progressBar.setAttribute("aria-valuenow", clamped);
}

function setProcessingState(isProcessing) {
    state.isProcessing = isProcessing;
    if (DOM.app) DOM.app.setAttribute("aria-busy", isProcessing ? "true" : "false");
    
    if (isProcessing) {
        if (DOM.loadingSpinner) DOM.loadingSpinner.classList.remove("hidden");
        if (DOM.overlay) DOM.overlay.classList.remove("hidden");
        if (DOM.goBtn) {
            DOM.goBtn.textContent = "To'xtatish (Cancel)";
            DOM.goBtn.disabled = false;
        }
    } else {
        if (DOM.loadingSpinner) DOM.loadingSpinner.classList.add("hidden");
        if (DOM.overlay) DOM.overlay.classList.add("hidden");
        if (DOM.goBtn) {
            DOM.goBtn.textContent = "Tarjima qilishni boshlash";
            DOM.goBtn.disabled = state.files.length === 0;
        }
    }
}

function cleanText(text) {
    if (!text) return "";
    return text.replace(/\s+/g, " ").trim();
}

// ======================================
// SOUND EFFECT (SFX) ANIQLASH
// ======================================
// Heuristika: manga effektlari odatda qisqa, deyarli butunlay katta harfda
// va ko'pincha undosh harflar ko'p bo'ladi (BOOM, BAM, WHOOSH, SLAM).
// Bunday matnlarni tarjima qilish shart emas - ular xalqaro tushunarli
// va tarjima qilinsa ko'pincha ma'nosini yo'qotadi.
const SFX_MAX_LENGTH = 12;

const SFX_KNOWN_WORDS = new Set([
    "boom", "bam", "slam", "whoosh", "bang", "crash", "thud", "pow",
    "smash", "zoom", "click", "clank", "gulp", "sigh", "huff", "puff",
    "swish", "snap", "crack", "rumble", "buzz", "ding", "clang"
]);

function isLikelySoundEffect(text) {

    const trimmed = (text ?? "").trim();

    if (trimmed === "" || trimmed.length > SFX_MAX_LENGTH) return false;

    // TUZATISH: avval faqat lotin harflari (a-zA-Z) qoldirilardi, shuning
    // uchun ruscha "БАМ", "КРАШ" kabi effektlar wordOnly="" bo'lib qolib,
    // umuman aniqlanmasdi. Endi kirill harflari ham hisobga olinadi.
    const wordOnly = trimmed.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, "");

    if (wordOnly.length === 0) return false;

    const lower = wordOnly.toLowerCase();

    if (SFX_KNOWN_WORDS.has(lower)) return true;

    // Butunlay katta harf + ko'p undosh + qisqa -> effekt bo'lish ehtimoli yuqori.
    // Lotin va kirill unlilari ikkalasi ham hisobga olinadi.
    const isAllCaps = wordOnly === wordOnly.toUpperCase();

    const vowelCount = (lower.match(/[aeiouаеёиоуыэюя]/g) || []).length;

    const consonantRatio = 1 - (vowelCount / lower.length);

    const hasExclamation = /!{1,}$/.test(trimmed);

    return isAllCaps && wordOnly.length <= 8 && (consonantRatio > 0.6 || hasExclamation);

}

function addToCache(key, val) {
    if (state.translationCache.size >= CONFIG.MAX_CACHE_SIZE) {
        const firstKey = state.translationCache.keys().next().value;
        state.translationCache.delete(firstKey);
    }
    state.translationCache.set(key, val);
}

// Fetch timeout bilan
// MUHIM TUZATISH: avval agar options.signal berilsa (masalan Cancel tugmasi
// uchun), mahalliy FETCH_TIMEOUT_MS butunlay e'tiborsiz qolardi - chunki faqat
// bitta signal ishlatilardi. Endi ikkalasi ham birga ishlaydi: foydalanuvchi
// Cancel bossa HAM, so'rov FETCH_TIMEOUT_MS dan uzoqqa cho'zilib ketsa HAM,
// so'rov to'xtatiladi.
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = CONFIG.FETCH_TIMEOUT_MS, signal: externalSignal, ...restOptions } = options;

    const timeoutController = new AbortController();
    const id = setTimeout(() => timeoutController.abort(), timeout);

    // Ikkala signalni birlashtiramiz: qaysi biri birinchi bo'lib abort qilinsa,
    // fetch ham darhol to'xtaydi.
    let combinedSignal = timeoutController.signal;

    if (externalSignal) {

        if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {

            combinedSignal = AbortSignal.any([timeoutController.signal, externalSignal]);

        } else {

            // AbortSignal.any mavjud bo'lmagan eski brauzerlar uchun qo'lda birlashtirish
            if (externalSignal.aborted) {
                timeoutController.abort();
            } else {
                externalSignal.addEventListener("abort", () => timeoutController.abort(), { once: true });
            }

        }

    }

    try {
        const response = await fetch(resource, {
            ...restOptions,
            signal: combinedSignal
        });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
        }

// ======================================
// SOZLAMALARNI BOSHQARISH
// ======================================

function setSourceLanguage(lang, element) {
    state.sourceLang = lang;
    updateActiveButton(element);
}

function setTargetLanguage(lang, element) {
    state.targetLang = lang;
    updateActiveButton(element);
}

function setFont(fontType, element) {
    state.fontFamily = fontType;
    document.body.classList.remove("font-manga", "font-handwritten", "font-custom");
    
    if (fontType === "manga") {
        document.body.classList.add("font-manga");
    } else if (fontType === "handwritten") {
        document.body.classList.add("font-handwritten");
    } else if (fontType === "custom") {
        document.body.classList.add("font-custom");
    }
    updateActiveButton(element);
}

// ======================================
// CUSTOM FONT (FontFace API orqali .ttf/.otf/.woff yuklash)
// ======================================
const CUSTOM_FONT_NAME = "KageUserFont";

async function loadCustomFont(file) {

    if (!file) return;

    if (typeof FontFace === "undefined") {
        showError("Brauzeringiz maxsus shrift yuklashni qo'llab-quvvatlamaydi.");
        return;
    }

    try {

        setStatus("Shrift yuklanmoqda...");

        const buffer = await file.arrayBuffer();

        const fontFace = new FontFace(CUSTOM_FONT_NAME, buffer);

        await fontFace.load();

        document.fonts.add(fontFace);

        // Ekran uchun CSS klass qo'shamiz (style.css'da oldindan yozilmagani
        // uchun dinamik <style> tegi orqali)
        let styleTag = document.getElementById("customFontStyleTag");

        if (!styleTag) {
            styleTag = document.createElement("style");
            styleTag.id = "customFontStyleTag";
            document.head.appendChild(styleTag);
        }

        styleTag.textContent = `
            body.font-custom .manga-text,
            body.font-custom.manga-text {
                font-family: "${CUSTOM_FONT_NAME}", sans-serif !important;
            }
        `;

        // PDF eksport uchun ham shu shriftni ishlatamiz
        EXPORT_FONT_MAP.custom = `"${CUSTOM_FONT_NAME}", sans-serif`;

        state.fontFamily = "custom";
        document.body.classList.remove("font-manga", "font-handwritten");
        document.body.classList.add("font-custom");

        showToast(`Shrift yuklandi: ${file.name}`);
        setStatus("Shrift tayyor.");

    } catch (err) {

        console.error(err);
        showError("Shrift faylini yuklab bo'lmadi: " + err.message);
        setStatus("Xatolik.");

    }

}

if (DOM.customFontInput) {

    DOM.customFontInput.addEventListener("change", (e) => {

        const file = e.target.files && e.target.files[0];

        if (file) loadCustomFont(file);

    });

}

function updateActiveButton(activeBtn) {
    if (!activeBtn || !activeBtn.parentElement) return;
    const buttons = activeBtn.parentElement.querySelectorAll("button");
    buttons.forEach((btn) => btn.classList.remove("active"));
    activeBtn.classList.add("active");
}

// Event Listeners
if (DOM.pdfInput) {
    DOM.pdfInput.addEventListener("change", (e) => {
        state.files = Array.from(e.target.files);
        if (state.files.length > 0) {
            setStatus(`${state.files.length} ta fayl tanlandi.`);
            if (DOM.goBtn) DOM.goBtn.disabled = false;
        } else {
            setStatus("Fayl tanlanmagan");
            if (DOM.goBtn) DOM.goBtn.disabled = true;
        }
    });
}

// Share & Image Download Eventlar
if (DOM.shareBtn) {
    DOM.shareBtn.addEventListener("click", async () => {
        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'Kage Translate',
                    text: 'Manga tarjimasi tayyor!',
                    url: window.location.href,
                });
            } catch (err) {
                console.log('Ulashish bekor qilindi');
            }
        } else {
            showToast("Brauzeringiz ulashishni qo'llab-quvvatlamaydi");
        }
    });
}

// Confirm Modal
function showConfirm(msg, onYes) {
    if (!DOM.confirmModal) return;
    DOM.confirmMessage.textContent = msg;
    DOM.confirmModal.classList.remove("hidden");
    DOM.overlay.classList.remove("hidden");
    
    DOM.confirmYes.onclick = () => {
        DOM.confirmModal.classList.add("hidden");
        DOM.overlay.classList.add("hidden");
        onYes();
    };
    DOM.confirmNo.onclick = () => {
        DOM.confirmModal.classList.add("hidden");
        DOM.overlay.classList.add("hidden");
    };
}

// ======================================
// OCR WORKER POOL (Parallel OCR uchun)
// ======================================
// Bitta Tesseract worker bir vaqtda faqat bitta sahifani o'qiy oladi.
// Bir nechta sahifani PARALLEL o'qish uchun bir nechta worker kerak.
// Telefon RAM/protsessoriga qarab pool hajmi avtomatik cheklanadi.

const TESS_LANG_MAP = { en: "eng", ru: "rus", uz: "uzb" };

function getOcrPoolSize() {

    const cores = navigator.hardwareConcurrency || 2;

    // navigator.deviceMemory barcha brauzerlarda mavjud emas (masalan Safari'da yo'q),
    // shuning uchun mavjud bo'lmasa "xavfsiz" deb hisoblanadi (o'rtacha qurilma)
    const memoryGb = navigator.deviceMemory || 4;

    if (memoryGb <= 2) return 1;

    if (cores <= 2) return 1;

    return Math.min(3, Math.floor(cores / 2));

}

async function initOcrPool(requiredLang) {

    if (state.ocrWorkerPool && state.ocrWorkerPool.length > 0 && state.ocrWorkerLang === requiredLang) {
        return;
    }

    await terminateOcrWorkerPool();

    const poolSize = getOcrPoolSize();

    setStatus(`OCR dvigateli yuklanmoqda (${poolSize} ta parallel worker)...`);

    const workers = [];

    for (let i = 0; i < poolSize; i++) {
        workers.push(await Tesseract.createWorker(requiredLang));
    }

    state.ocrWorkerPool = workers;

    state.ocrWorkerLang = requiredLang;

}

async function terminateOcrWorkerPool() {

    if (state.ocrWorkerPool && state.ocrWorkerPool.length > 0) {

        await Promise.all(state.ocrWorkerPool.map((w) => w.terminate()));

    }

    state.ocrWorkerPool = [];

    state.ocrWorkerLang = null;

}

// Eski kod bilan moslik uchun: bitta rasm/canvas'ni pool'dagi birinchi
// worker orqali o'qish (rasm fayllar uchun ishlatiladi - parallellik shart emas)
async function recognizeText(imageSource) {

    const requiredLang = TESS_LANG_MAP[state.sourceLang] || "eng";

    await initOcrPool(requiredLang);

    const worker = state.ocrWorkerPool[0];

    const result = await worker.recognize(imageSource);

    return result.data;

}

// Bounded-concurrency task runner: items ro'yxatini poolSize ta "worker"da
// parallel ishlaydi, lekin natijalarni ORIGINAL tartibda qaytaradi
// (tugash tartibi boshqacha bo'lsa ham).
async function runWithPool(items, poolSize, taskFn) {

    const results = new Array(items.length);

    let nextIndex = 0;

    async function runner(workerIndex) {

        while (true) {

            const current = nextIndex++;

            if (current >= items.length) return;

            results[current] = await taskFn(items[current], current, workerIndex);

        }

    }

    const runners = [];

    for (let i = 0; i < poolSize; i++) {
        runners.push(runner(i));
    }

    await Promise.all(runners);

    return results;

            }
    

// ======================================
// TARJIMA ENGINE (Retry + Batch Parallel)
// ======================================

// ======================================
// KONTEKSTLI TARJIMA (qisqa ketma-ket bloklarni birga tarjima qilish)
// ======================================
// Muammo: "I" / "love" / "you" kabi qisqa bloklar alohida-alohida
// tarjima qilinsa, tarjima tizimi kontekstni ko'rmaydi va sifat pasayadi.
// Yechim: ketma-ket qisqa bloklarni bitta so'rovda (\n bilan ajratib)
// birga yuboramiz. XAVFSIZLIK: agar qaytgan segmentlar soni yuborilgan
// bloklar soniga mos kelmasa, natija ISHONCHSIZ deb hisoblanadi va har bir
// blok ALOHIDA qayta tarjima qilinadi - shu orqali noto'g'ri joyga
// tarjima chiqib ketishining oldi butunlay olinadi.

const CONTEXT_GROUP_MAX_WORDS = 3;

const CONTEXT_GROUP_MAX_SIZE = 3;

function isShortBlock(text) {

    const words = text.trim().split(/\s+/).filter(Boolean);

    return words.length > 0 && words.length <= CONTEXT_GROUP_MAX_WORDS;

}

// ======================================
// GLOSSARY / LUG'AT (Ism va atamalarni himoya qilish)
// ======================================
// Tarjima tizimlari (Google/MyMemory) ismlarni ko'pincha noto'g'ri yoki
// nomuvofiq tarjima qiladi (masalan "Naruto" -> "Nartu"). Yechim: tarjimadan
// OLDIN lug'atdagi atamalarni noyob "niqob" token bilan almashtiramiz (API
// ularga tegmasin uchun), tarjimadan KEYIN token'larni foydalanuvchi bergan
// aniq matn bilan qayta tiklaymiz.
//
// ESLATMA: bu "eng yaxshi urinish" (best-effort) usuli - tarjima tizimi
// nazariy jihatdan token'ni ham biroz o'zgartirib qo'yishi mumkin (kamdan-kam
// holatda). Kafolatlangan lug'at qo'llab-quvvatlashi faqat pullik API'larda
// (masalan DeepL Glossary) mavjud.

let glossaryMaskCounter = 0;

function applyGlossaryMask(text) {

    const terms = Object.keys(state.userGlossary || {}).filter(Boolean);

    if (terms.length === 0) return { maskedText: text, replacements: [] };

    // Uzunroq atamalarni avval almashtiramiz (masalan "Shadow Clone Jutsu"
    // ichidagi "Shadow Clone" bilan chalkashib ketmasligi uchun)
    const sortedTerms = terms.slice().sort((a, b) => b.length - a.length);

    let maskedText = text;

    const replacements = [];

    for (const term of sortedTerms) {

        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        const regex = new RegExp(`\\b${escaped}\\b`, "gi");

        maskedText = maskedText.replace(regex, () => {

            glossaryMaskCounter++;

            const token = `Xkgtoken${glossaryMaskCounter}x`;

            replacements.push({ token, target: state.userGlossary[term] });

            return token;

        });

    }

    return { maskedText, replacements };

}

function restoreGlossary(translatedText, replacements) {

    let result = translatedText;

    for (const r of replacements) {

        const tokenRegex = new RegExp(r.token, "gi");

        result = result.replace(tokenRegex, r.target);

    }

    return result;

}

async function translateGroupWithContext(texts) {

    if (texts.length < 2) return null;

    const maskedItems = texts.map((t) => applyGlossaryMask(t));

    const joined = maskedItems.map((m) => m.maskedText).join("\n");

    try {

        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${state.sourceLang}&tl=${state.targetLang}&dt=t&q=${encodeURIComponent(joined)}`;

        const res = await fetchWithTimeout(url, { signal: state.abortController?.signal });

        if (!res.ok) return null;

        const data = await res.json();

        if (!data || !data[0]) return null;

        const segments = data[0].map((item) => item[0]);

        // Segment soni mos kelmasa - ISHONMAYMIZ, xavfsiz fallback'ga o'tkazamiz
        if (segments.length !== texts.length) return null;

        return segments.map((s, idx) => restoreGlossary(s.trim(), maskedItems[idx].replacements));

    } catch (e) {

        return null;

    }

}

async function translateSingleText(text) {
    const cleaned = cleanText(text);
    if (!cleaned) return "";

    const cacheKey = `${state.sourceLang}_${state.targetLang}_${cleaned}`;
    if (state.translationCache.has(cacheKey)) {
        return state.translationCache.get(cacheKey);
    }

    const { maskedText, replacements } = applyGlossaryMask(cleaned);

    let translated = null;

    // Retry mexanizmi bilan Google Translate
    for (let attempt = 0; attempt < CONFIG.TRANSLATE_MAX_RETRIES; attempt++) {
        if (state.abortController?.signal.aborted) break;
        try {
            translated = await translateViaGoogle(maskedText);
            if (translated) break;
        } catch (e) {
            await new Promise(r => setTimeout(r, CONFIG.TRANSLATE_RETRY_DELAY_MS));
        }
    }

    // Fallback: MyMemory
    if (!translated && !state.abortController?.signal.aborted) {
        translated = await translateViaMyMemory(maskedText);
    }

    let finalResult = translated || maskedText;

    // Lug'at token'larini aniq matn bilan qayta tiklaymiz, keyin CACHE'GA
    // yakuniy (tiklangan) natijani saqlaymiz - shunda keyingi chaqiruvlarda
    // token raqamlari mos kelmasligi bilan bog'liq muammo bo'lmaydi.
    finalResult = restoreGlossary(finalResult, replacements);

    addToCache(cacheKey, finalResult);
    return finalResult;
}

async function translateViaGoogle(text) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${state.sourceLang}&tl=${state.targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetchWithTimeout(url, { signal: state.abortController?.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data[0] ? data[0].map(item => item[0]).join("") : null;
}

async function translateViaMyMemory(text) {
    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${state.sourceLang}|${state.targetLang}`;
        const res = await fetchWithTimeout(url, { signal: state.abortController?.signal });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.responseData?.translatedText || null;
    } catch (e) {
        return null;
    }
}

// Batch bo'yicha parallel tarjima qilish (kontekst-guruhlash bilan)
async function translateBatch(blocks, onProgress) {

    const results = new Array(blocks.length).fill("");

    const cleanedTexts = blocks.map((b) => cleanText(b.text));

    // 1-bosqich: bo'sh va sound-effect bloklarni darhol hal qilamiz
    const pendingIndices = [];

    for (let i = 0; i < blocks.length; i++) {

        const txt = cleanedTexts[i];

        if (!txt) { results[i] = ""; continue; }

        if (isLikelySoundEffect(txt)) { results[i] = txt; continue; }

        pendingIndices.push(i);

    }

    // 2-bosqich: qolgan bloklarni "guruhlar"ga ajratamiz - ketma-ket va qisqa
    // bo'lganlar bitta kontekst guruhiga birlashadi, qolganlari yakka guruh bo'ladi
    const groups = [];

    let i = 0;

    while (i < pendingIndices.length) {

        const idx = pendingIndices[i];

        const txt = cleanedTexts[idx];

        if (isShortBlock(txt)) {

            const group = { indices: [idx], texts: [txt] };

            let j = i + 1;

            while (
                j < pendingIndices.length &&
                group.indices.length < CONTEXT_GROUP_MAX_SIZE &&
                pendingIndices[j] === pendingIndices[j - 1] + 1 &&
                isShortBlock(cleanedTexts[pendingIndices[j]])
            ) {

                group.indices.push(pendingIndices[j]);
                group.texts.push(cleanedTexts[pendingIndices[j]]);
                j++;

            }

            groups.push(group);
            i = j;

        } else {

            groups.push({ indices: [idx], texts: [txt] });
            i++;

        }

    }

    // 3-bosqich: guruhlarni CONFIG.BATCH_SIZE bo'yicha parallel tarjima qilamiz
    let completedGroups = 0;

    for (let g = 0; g < groups.length; g += CONFIG.BATCH_SIZE) {

        if (state.abortController?.signal.aborted) break;

        const chunk = groups.slice(g, g + CONFIG.BATCH_SIZE);

        await Promise.all(chunk.map(async (group) => {

            if (group.texts.length > 1) {

                const cacheKey = `ctx_${state.sourceLang}_${state.targetLang}_${group.texts.join("|")}`;

                if (state.translationCache.has(cacheKey)) {

                    const cached = state.translationCache.get(cacheKey);

                    cached.forEach((t, k) => { results[group.indices[k]] = t; });

                    return;

                }

                const groupResult = await translateGroupWithContext(group.texts);

                if (groupResult) {

                    addToCache(cacheKey, groupResult);

                    groupResult.forEach((t, k) => { results[group.indices[k]] = t; });

                    return;

                }

                // Guruh tarjimasi ishonchsiz bo'ldi - xavfsiz fallback: har birini alohida tarjima qilamiz

            }

            for (const idx of group.indices) {

                results[idx] = await translateSingleText(cleanedTexts[idx]);

            }

        }));

        completedGroups += chunk.length;

        if (onProgress) {
            onProgress(completedGroups / groups.length);
        }

    }

    return results;

        }
                
// ======================================
// PIPELINE & RENDERING
// ======================================

function toggleStartCancel() {
    if (state.isProcessing) {
        if (state.abortController) {
            state.abortController.abort();
            setStatus("Jarayon bekor qilindi.");
            setProcessingState(false);
        }
    } else {
        startTranslation();
    }
}

async function startTranslation() {
    if (state.files.length === 0) return;

    state.abortController = new AbortController();
    setProcessingState(true);
    updateProgress(0);

    clearDOMPreview();

    try {
        const totalFiles = state.files.length;
        for (let i = 0; i < totalFiles; i++) {
            if (state.abortController.signal.aborted) break;

            const file = state.files[i];
            if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
                await processPdfFile(file);
            } else if (file.type.startsWith("image/")) {
                await processImageFile(file);
            }
        }

        if (!state.abortController.signal.aborted) {
            setStatus("Tarjima muvaffaqiyatli yakunlandi!");
            showToast("Tarjima tayyor!");
            if (DOM.downloadPdfBtn) DOM.downloadPdfBtn.disabled = false;
            if (DOM.downloadBtn) DOM.downloadBtn.classList.remove("hidden");
            if (DOM.shareBtn) DOM.shareBtn.classList.remove("hidden");
            updateProgress(100);
        }
    } catch (err) {
        if (err.name !== "AbortError") {
            console.error(err);
            showError("Xatolik yuz berdi: " + err.message);
            setStatus("Xatolik yuz berdi.");
        }
    } finally {
        await terminateOcrWorkerPool(); // Memory Leak oldini olish
        setProcessingState(false);
    }
}

function clearDOMPreview() {
    if (DOM.results) DOM.results.textContent = "";
    if (DOM.pdfPreview) DOM.pdfPreview.textContent = "";
    if (DOM.ocrLayer) DOM.ocrLayer.textContent = "";
    if (DOM.previewArea) DOM.previewArea.classList.remove("hidden");
    state.pageRenderData = [];
}

async function processPdfFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const numPages = pdf.numPages;

    const requiredLang = TESS_LANG_MAP[state.sourceLang] || "eng";

    await initOcrPool(requiredLang);

    const poolSize = state.ocrWorkerPool.length;

    let completedPages = 0;

    setStatus(`PDF ishlanmoqda (${poolSize} ta parallel worker)...`);

    // Har bir sahifa: render -> OCR (pool'dagi mos worker orqali) -> tarjima.
    // runWithPool natijalarni ORIGINAL sahifa tartibida qaytaradi, garchi
    // sahifalar boshqacha tartibda tugasa ham - shuning uchun keyinroq DOM'ga
    // chiqarishda 1,2,3... tartib buzilmaydi.
    const pageResults = await runWithPool(
        Array.from({ length: numPages }, (_, i) => i + 1),
        poolSize,
        async (pageNum, _idx, workerIndex) => {

            if (state.abortController?.signal.aborted) return null;

            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: CONFIG.PDF_SCALE });

            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({ canvasContext: ctx, viewport }).promise;

            const worker = state.ocrWorkerPool[workerIndex % state.ocrWorkerPool.length];

            const ocrResult = await worker.recognize(canvas);

            const ocrData = ocrResult.data;

            const blocks = ocrData.blocks || ocrData.paragraphs || ocrData.lines || [];

            const translatedTexts = await translateBatch(blocks, null);

            page.cleanup();

            completedPages++;

            setStatus(`PDF sahifasi ${completedPages}/${numPages} tayyor...`);

            updateProgress((completedPages / numPages) * 100);

            return {
                pageNum,
                canvas,
                blocks,
                translatedTexts,
                width: viewport.width,
                height: viewport.height
            };

        }
    );

    // Natijalarni sahifa tartibida (1,2,3...) DOM'ga chiqaramiz
    for (const result of pageResults) {

        if (!result) continue;

        const pageIndex = state.pageRenderData.length;

        if (DOM.pdfPreview) DOM.pdfPreview.appendChild(result.canvas);

        renderBlocksSafely(result.canvas, result.blocks, result.translatedTexts, result.width, result.height, pageIndex);

        // Eksport uchun asl piksel ma'lumotini saqlaymiz (DOM/CSS ga bog'liq emas)
        state.pageRenderData.push({
            canvas: result.canvas,
            blocks: result.blocks,
            translations: result.translatedTexts,
            width: result.width,
            height: result.height
        });

    }
}

async function processImageFile(file) {
    setStatus("Rasm qayta ishlanmoqda...");
    const img = new Image();
    const url = URL.createObjectURL(file);

    await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    if (DOM.pdfPreview) DOM.pdfPreview.appendChild(canvas);

    const ocrData = await recognizeText(canvas);
    const blocks = ocrData.blocks || ocrData.paragraphs || ocrData.lines || [];

    const translatedTexts = await translateBatch(blocks, (p) => {
        updateProgress(p * 100);
    });

    const pageIndex = state.pageRenderData.length;

    renderBlocksSafely(canvas, blocks, translatedTexts, img.width, img.height, pageIndex);

    // Eksport uchun asl piksel ma'lumotini saqlaymiz
    state.pageRenderData.push({
        canvas,
        blocks,
        translations: translatedTexts,
        width: img.width,
        height: img.height
    });

    // RAM tozalash
    URL.revokeObjectURL(url);
    img.remove();
}

// ======================================
// PIPELINE & RENDERING
// ======================================

function toggleStartCancel() {
    if (state.isProcessing) {
        if (state.abortController) {
            state.abortController.abort();
            setStatus("Jarayon bekor qilindi.");
            setProcessingState(false);
        }
    } else {
        startTranslation();
    }
}

async function startTranslation() {
    if (state.files.length === 0) return;

    state.abortController = new AbortController();
    setProcessingState(true);
    updateProgress(0);

    clearDOMPreview();

    try {
        const totalFiles = state.files.length;
        for (let i = 0; i < totalFiles; i++) {
            if (state.abortController.signal.aborted) break;

            const file = state.files[i];
            if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
                await processPdfFile(file);
            } else if (file.type.startsWith("image/")) {
                await processImageFile(file);
            }
        }

        if (!state.abortController.signal.aborted) {
            setStatus("Tarjima muvaffaqiyatli yakunlandi!");
            showToast("Tarjima tayyor!");
            if (DOM.downloadPdfBtn) DOM.downloadPdfBtn.disabled = false;
            if (DOM.downloadBtn) DOM.downloadBtn.classList.remove("hidden");
            if (DOM.shareBtn) DOM.shareBtn.classList.remove("hidden");
            updateProgress(100);
        }
    } catch (err) {
        if (err.name !== "AbortError") {
            console.error(err);
            showError("Xatolik yuz berdi: " + err.message);
            setStatus("Xatolik yuz berdi.");
        }
    } finally {
        await terminateOcrWorkerPool(); // Memory Leak oldini olish
        setProcessingState(false);
    }
}

function clearDOMPreview() {
    if (DOM.results) DOM.results.textContent = "";
    if (DOM.pdfPreview) DOM.pdfPreview.textContent = "";
    if (DOM.ocrLayer) DOM.ocrLayer.textContent = "";
    if (DOM.previewArea) DOM.previewArea.classList.remove("hidden");
    state.pageRenderData = [];
}

async function processPdfFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const numPages = pdf.numPages;

    const requiredLang = TESS_LANG_MAP[state.sourceLang] || "eng";

    await initOcrPool(requiredLang);

    const poolSize = state.ocrWorkerPool.length;

    let completedPages = 0;

    setStatus(`PDF ishlanmoqda (${poolSize} ta parallel worker)...`);

    // Har bir sahifa: render -> OCR (pool'dagi mos worker orqali) -> tarjima.
    // runWithPool natijalarni ORIGINAL sahifa tartibida qaytaradi, garchi
    // sahifalar boshqacha tartibda tugasa ham - shuning uchun keyinroq DOM'ga
    // chiqarishda 1,2,3... tartib buzilmaydi.
    const pageResults = await runWithPool(
        Array.from({ length: numPages }, (_, i) => i + 1),
        poolSize,
        async (pageNum, _idx, workerIndex) => {

            if (state.abortController?.signal.aborted) return null;

            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: CONFIG.PDF_SCALE });

            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({ canvasContext: ctx, viewport }).promise;

            const worker = state.ocrWorkerPool[workerIndex % state.ocrWorkerPool.length];

            const ocrResult = await worker.recognize(canvas);

            const ocrData = ocrResult.data;

            const blocks = ocrData.blocks || ocrData.paragraphs || ocrData.lines || [];

            const translatedTexts = await translateBatch(blocks, null);

            page.cleanup();

            completedPages++;

            setStatus(`PDF sahifasi ${completedPages}/${numPages} tayyor...`);

            updateProgress((completedPages / numPages) * 100);

            return {
                pageNum,
                canvas,
                blocks,
                translatedTexts,
                width: viewport.width,
                height: viewport.height
            };

        }
    );

    // Natijalarni sahifa tartibida (1,2,3...) DOM'ga chiqaramiz
    for (const result of pageResults) {

        if (!result) continue;

        const pageIndex = state.pageRenderData.length;

        if (DOM.pdfPreview) DOM.pdfPreview.appendChild(result.canvas);

        renderBlocksSafely(result.canvas, result.blocks, result.translatedTexts, result.width, result.height, pageIndex);

        // Eksport uchun asl piksel ma'lumotini saqlaymiz (DOM/CSS ga bog'liq emas)
        state.pageRenderData.push({
            canvas: result.canvas,
            blocks: result.blocks,
            translations: result.translatedTexts,
            width: result.width,
            height: result.height
        });

    }
}

async function processImageFile(file) {
    setStatus("Rasm qayta ishlanmoqda...");
    const img = new Image();
    const url = URL.createObjectURL(file);

    await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    if (DOM.pdfPreview) DOM.pdfPreview.appendChild(canvas);

    const ocrData = await recognizeText(canvas);
    const blocks = ocrData.blocks || ocrData.paragraphs || ocrData.lines || [];

    const translatedTexts = await translateBatch(blocks, (p) => {
        updateProgress(p * 100);
    });

    const pageIndex = state.pageRenderData.length;

    renderBlocksSafely(canvas, blocks, translatedTexts, img.width, img.height, pageIndex);

    // Eksport uchun asl piksel ma'lumotini saqlaymiz
    state.pageRenderData.push({
        canvas,
        blocks,
        translations: translatedTexts,
        width: img.width,
        height: img.height
    });

    // RAM tozalash
    URL.revokeObjectURL(url);
    img.remove();
}

// ======================================
// AUTO FONT FIT (Bubble ichiga avtomatik moslashuv)
// ======================================
// Bubble ichidagi tarjima matni katta bo'lsa, ramkadan chiqib ketmasligi
// uchun shrift o'lchami bosqichma-bosqich kichraytiriladi.

const OVERLAY_FONT_MAX = 20;

// OCR ishonchlilik chegarasi (0-100). Shundan past bo'lsa foydalanuvchiga
// ogohlantirish ko'rsatiladi (matn noto'g'ri o'qilgan bo'lishi mumkin).
const LOW_CONFIDENCE_THRESHOLD = 60;

const OVERLAY_FONT_MIN = 8;

const OVERLAY_FONT_STEP = 1;

function applyAutoFontFit(bubbleEl, boxWidth, boxHeight) {

    if (!bubbleEl || boxWidth <= 0 || boxHeight <= 0) return;

    let fontSize = OVERLAY_FONT_MAX;

    bubbleEl.style.fontSize = fontSize + "px";

    // Matn ramkaga sig'guncha shrift o'lchamini kichraytiramiz.
    // scrollWidth/scrollHeight - elementning haqiqiy (to'ldirilgan) o'lchami,
    // bu esa taxsis qilingan bbox o'lchamidan katta bo'lsa, hali sig'mayapti demak.
    while (
        fontSize > OVERLAY_FONT_MIN &&
        (bubbleEl.scrollHeight > boxHeight || bubbleEl.scrollWidth > boxWidth)
    ) {

        fontSize -= OVERLAY_FONT_STEP;

        bubbleEl.style.fontSize = fontSize + "px";

    }

}
// MUHIM TUZATISH: avval DOM.pdfPreview.clientWidth (butun konteyner kengligi)
// barcha sahifalar uchun umumiy scaleFactor sifatida ishlatilardi. Bu
// ko'p-sahifali PDF'larda yoki sahifalar turli o'lchamda bo'lganda bubble
// koordinatalarini noto'g'ri joyga surib yuborardi. Endi HAR BIR canvas
// o'zining SHAXSIY clientWidth'idan foydalanadi.
function renderBlocksSafely(canvasEl, blocks, translations, renderWidth, renderHeight, pageIndex) {
    if (!DOM.ocrLayer || !DOM.results) return;

    const displayedWidth = (canvasEl && canvasEl.clientWidth) || renderWidth;
    const scaleFactor = displayedWidth / renderWidth;

    blocks.forEach((block, index) => {
        const translated = translations[index];
        const originalText = cleanText(block.text);
        if (!originalText || !translated) return;

        const isSfx = isLikelySoundEffect(originalText);

        // Tesseract odatda block.confidence (0-100) qaytaradi. Bu qiymat
        // past bo'lsa, OCR matnni noto'g'ri o'qigan bo'lishi mumkin -
        // foydalanuvchiga shubhali natija ekanini bildiramiz.
        const confidence = typeof block.confidence === "number" ? block.confidence : null;

        const isLowConfidence = confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD;

        // 1. Matnli Card chiqarish (XSS protection)
        const card = document.createElement("div");
        card.className = "card" + (isSfx ? " card-sfx" : "") + (isLowConfidence ? " card-low-confidence" : "");
        card.style.marginTop = "8px";

        const origP = document.createElement("p");
        origP.className = "result-card-text";
        origP.textContent = originalText + (isSfx ? "  🔊 (effekt)" : "");

        if (isLowConfidence) {
            const warningSpan = document.createElement("span");
            warningSpan.className = "badge-warning";
            warningSpan.textContent = `⚠️ past aniqlik (${Math.round(confidence)}%)`;
            card.appendChild(warningSpan);
        }

        const transP = document.createElement("p");
        transP.className = "result-card-translated manga-text";
        transP.textContent = translated;

        card.appendChild(origP);
        card.appendChild(transP);
        DOM.results.appendChild(card);

        // 2. OCR Layer (Overlay Bubble) joylash - TAHRIRLANADIGAN (contenteditable)
        if (block.bbox) {
            const box = block.bbox;
            const bubble = document.createElement("div");
            bubble.className = "ocr-bubble-text manga-text" + (isSfx ? " ocr-bubble-sfx" : "");
            
            // Scaled Koordinatalar
            bubble.style.left = `${box.x0 * scaleFactor}px`;
            bubble.style.top = `${box.y0 * scaleFactor}px`;
            bubble.style.width = `${(box.x1 - box.x0) * scaleFactor}px`;
            bubble.style.height = `${(box.y1 - box.y0) * scaleFactor}px`;
            bubble.textContent = translated;

            // Preview Edit: foydalanuvchi bubble ichini to'g'ridan-to'g'ri
            // tahrirlashi mumkin. Qaysi sahifa/blokka tegishli ekanini
            // data-atributlar orqali eslab qolamiz.
            bubble.contentEditable = "true";
            bubble.spellcheck = false;
            bubble.title = "Tahrirlash uchun bosing";
            bubble.dataset.pageIndex = pageIndex;
            bubble.dataset.blockIndex = index;
            bubble.addEventListener("input", onBubbleTextEdited);

            DOM.ocrLayer.appendChild(bubble);

            applyAutoFontFit(bubble, (box.x1 - box.x0) * scaleFactor, (box.y1 - box.y0) * scaleFactor);
        }
    });
}

// Bubble tahrirlanganda: state.pageRenderData'ga yozamiz (shunda PDF eksport
// foydalanuvchi tahrirlagan variantni oladi) va shrift o'lchamini qayta moslaymiz
// (matn uzunligi o'zgargani uchun).
function onBubbleTextEdited(e) {

    const el = e.currentTarget;

    const pageIndex = parseInt(el.dataset.pageIndex, 10);
    const blockIndex = parseInt(el.dataset.blockIndex, 10);
    const newText = el.textContent;

    if (
        Number.isInteger(pageIndex) &&
        Number.isInteger(blockIndex) &&
        state.pageRenderData[pageIndex] &&
        state.pageRenderData[pageIndex].translations
    ) {
        state.pageRenderData[pageIndex].translations[blockIndex] = newText;
    }

    const boxWidth = parseFloat(el.style.width) || el.clientWidth;
    const boxHeight = parseFloat(el.style.height) || el.clientHeight;

    applyAutoFontFit(el, boxWidth, boxHeight);

            }
// ======================================
// PDF EXPORT (Overlay bilan birga)
// ======================================

// Canvas'da matnni so'zlar bo'yicha qatorlarga bo'lib, markazga tekislab chizish
// (ctx.fillText o'zi qator bo'lmaydi, shuning uchun bu qo'lda qilinadi).
// TUZATISH: agar bitta "so'z" (bo'shliqsiz) o'zi maxWidth'dan katta bo'lsa
// (masalan "AAAAAHHHHHH!!!" yoki bo'shliqsiz yozuvli tillar - yapon/xitoy),
// u endi harflar bo'yicha ham bo'linadi, aks holda chegaradan chiqib ketardi.
function drawWrappedText(ctx, text, centerX, centerY, maxWidth, lineHeight) {

    const words = (text ?? "").split(" ");

    const lines = [];

    let currentLine = "";

    function pushLine(line) {
        if (line !== "") lines.push(line);
    }

    for (const word of words) {

        // Agar so'zning o'zi ham maxWidth'dan katta bo'lsa - uni harflar
        // bo'yicha bo'lamiz (bo'shliqsiz tillar/uzun effektlar uchun)
        if (ctx.measureText(word).width > maxWidth) {

            pushLine(currentLine);
            currentLine = "";

            let charChunk = "";

            for (const ch of word) {

                const testChunk = charChunk + ch;

                if (ctx.measureText(testChunk).width > maxWidth && charChunk !== "") {

                    lines.push(charChunk);
                    charChunk = ch;

                } else {

                    charChunk = testChunk;

                }

            }

            currentLine = charChunk;

            continue;

        }

        const testLine = currentLine === "" ? word : currentLine + " " + word;

        if (ctx.measureText(testLine).width > maxWidth && currentLine !== "") {

            lines.push(currentLine);

            currentLine = word;

        } else {

            currentLine = testLine;

        }

    }

    pushLine(currentLine);

    const totalHeight = lines.length * lineHeight;

    const startY = centerY - totalHeight / 2 + lineHeight / 2;

    lines.forEach((line, index) => {

        ctx.fillText(line, centerX, startY + index * lineHeight);

    });

}

// Canvas-native Auto Font Fit: DOM'ga bog'liq bo'lmagan holda, matn
// berilgan quti (box) ichiga sig'guncha shrift o'lchamini kichraytiradi.
// PDF eksportda applyAutoFontFit() (DOM versiyasi) o'rniga shu ishlatiladi,
// chunki eksport butunlay DOM'dan mustaqil bo'lishi kerak (scale xatosi
// oldini olish uchun).
const EXPORT_FONT_MAX = 28;

const EXPORT_FONT_MIN = 8;

function fitFontSizeToBox(ctx, text, maxWidth, maxHeight, fontFamily) {

    let fontSize = EXPORT_FONT_MAX;

    while (fontSize > EXPORT_FONT_MIN) {

        ctx.font = `bold ${fontSize}px ${fontFamily}`;

        const lineHeight = fontSize * 1.15;

        // Taxminiy qator sonini hisoblaymiz (drawWrappedText bilan bir xil mantiq)
        const words = text.split(" ");

        let lineCount = 1;

        let currentWidth = 0;

        for (const word of words) {

            const wordWidth = ctx.measureText(word + " ").width;

            if (currentWidth + wordWidth > maxWidth && currentWidth > 0) {

                lineCount++;
                currentWidth = wordWidth;

            } else {

                currentWidth += wordWidth;

            }

        }

        const estimatedHeight = lineCount * lineHeight;

        if (estimatedHeight <= maxHeight) {

            return fontSize;

        }

        fontSize -= 1;

    }

    return EXPORT_FONT_MIN;

}

// CSS'dagi shrift klasslariga mos canvas font-family satrlari
// (style.css'dagi --font-manga / --font-handwritten bilan bir xil bo'lishi kerak)
const EXPORT_FONT_MAP = {
    normal: "sans-serif",
    manga: "'Bangers', cursive, sans-serif",
    handwritten: "'Caveat', cursive, sans-serif"
};

// Ba'zi eski Android brauzerlarida ctx.roundRect() mavjud emas,
// shuning uchun burchaklarni qo'lda chizamiz (keng qo'llab-quvvatlanadi).
function drawRoundedRect(ctx, x, y, width, height, radius) {

    const r = Math.max(0, Math.min(radius, width / 2, height / 2));

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();

}

// MUHIM TUZATISH: avval bu funksiya DOM'dagi .ocr-bubble-text elementlarining
// CSS style (left/top/width/height/fontSize) qiymatlarini o'qib, ularni QAYTA
// canvas piksel o'lchamiga masshtablardi. Bu ikki marta masshtablash edi
// (DOM allaqachon bir marta kichraytirilgan, keyin yana teskari kattalashtirilar edi),
// va ko'p-sahifali PDF'larda umuman noto'g'ri natija berardi.
// Endi bu funksiya DOM'ga UMUMAN qaramaydi - state.pageRenderData ichida
// saqlangan ASL piksel koordinatalaridan (block.bbox) to'g'ridan-to'g'ri
// foydalanadi, chunki ular allaqachon canvas.width/height bilan bir xil
// piksel fazosida (hech qanday scaleFactor kerak emas).
async function downloadTranslatedPdf() {
    if (!window.jspdf) {
        showError("jsPDF kutubxonasi yuklanmagan!");
        return;
    }

    if (!state.pageRenderData || state.pageRenderData.length === 0) {
        showError("Yuklab olish uchun rasm topilmadi.");
        return;
    }

    const { jsPDF } = window.jspdf;

    setStatus("Eksport uchun PDF tayyorlanmoqda...");

    // MUHIM: agar Bangers/Caveat kabi Google Fonts hali yuklanmagan bo'lsa,
    // canvas ularni jim tarzda standart shriftga almashtiradi. Shuning uchun
    // eksportdan oldin shriftlar to'liq tayyor bo'lishini kutamiz.
    if (document.fonts && document.fonts.ready) {
        try {
            await document.fonts.ready;
        } catch (fontError) {
            console.warn("Shriftlarni kutishda muammo:", fontError);
        }
    }

    const doc = new jsPDF();

    const exportFontFamily = EXPORT_FONT_MAP[state.fontFamily] || EXPORT_FONT_MAP.normal;

    for (let i = 0; i < state.pageRenderData.length; i++) {

        if (i > 0) doc.addPage();

        const pageData = state.pageRenderData[i];

        const exportCanvas = document.createElement("canvas");
        exportCanvas.width = pageData.width;
        exportCanvas.height = pageData.height;
        const ctx = exportCanvas.getContext("2d");

        // 1. Asosiy manga tasvirini 1:1 chizish (hech qanday masshtablash yo'q)
        ctx.drawImage(pageData.canvas, 0, 0);

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        pageData.blocks.forEach((block, index) => {

            const translated = pageData.translations[index];

            const originalText = cleanText(block.text);

            if (!originalText || !translated || !block.bbox) return;

            const isSfx = isLikelySoundEffect(originalText);

            const box = block.bbox;

            const left = box.x0;
            const top = box.y0;
            const width = box.x1 - box.x0;
            const height = box.y1 - box.y0;

            if (width <= 0 || height <= 0) return;

            // Oq fon va ramka (SFX uchun fon shaffofroq/qizg'ish)
            ctx.fillStyle = isSfx ? "rgba(255, 235, 220, 0.9)" : "#ffffff";
            drawRoundedRect(ctx, left, top, width, height, Math.min(14, width / 4, height / 4));
            ctx.fill();
            ctx.strokeStyle = "#000000";
            ctx.stroke();

            // Shrift o'lchamini ASL bubble balandligidan hisoblaymiz (DOM'dan emas),
            // keyin matn kengligiga sig'guncha canvas ichida measureText bilan
            // kichraytiramiz - bu Auto Font Fit'ning canvas uchun mustaqil versiyasi.
            const canvasFontSize = fitFontSizeToBox(ctx, translated, width - 6, height - 4, exportFontFamily);

            ctx.fillStyle = "#000000";
            ctx.font = `bold ${canvasFontSize}px ${exportFontFamily}`;

            drawWrappedText(ctx, translated, left + width / 2, top + height / 2, width - 6, canvasFontSize * 1.15);

        });

        const imgData = exportCanvas.toDataURL("image/jpeg", 0.85);
        const pdfWidth = doc.internal.pageSize.getWidth();
        const pdfHeight = (exportCanvas.height * pdfWidth) / exportCanvas.width;

        doc.addImage(imgData, "JPEG", 0, 0, pdfWidth, pdfHeight);
    }

    doc.save("Kage_Manga_Translated.pdf");
    showToast("PDF muvaffaqiyatli saqlandi!");
    setStatus("Tayyor.");
}

// Global window funksiyalari
// Glossary matnini ("Naruto=Naruto" formatida, har qatorda bitta atama)
// tahlil qilib state.userGlossary ga yozadi
function applyGlossaryFromText(rawText) {

    const glossary = {};

    const lines = (rawText || "").split("\n");

    for (const line of lines) {

        const trimmed = line.trim();

        if (trimmed === "" || !trimmed.includes("=")) continue;

        const [source, ...rest] = trimmed.split("=");

        const target = rest.join("=").trim();

        const sourceTrimmed = source.trim();

        if (sourceTrimmed && target) {
            glossary[sourceTrimmed] = target;
        }

    }

    state.userGlossary = glossary;

    const count = Object.keys(glossary).length;

    showToast(count > 0 ? `Lug'at yangilandi: ${count} ta atama` : "Lug'at bo'shatildi");

    return count;

}

if (DOM.glossaryApplyBtn && DOM.glossaryInput) {

    DOM.glossaryApplyBtn.addEventListener("click", () => {
        applyGlossaryFromText(DOM.glossaryInput.value);
    });

}

window.startTranslation = toggleStartCancel;
window.setSourceLanguage = setSourceLanguage;
window.setTargetLanguage = setTargetLanguage;
window.setFont = setFont;
window.closeErrorModal = closeErrorModal;
window.downloadTranslatedPdf = downloadTranslatedPdf;
