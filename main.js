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
    ocrWorker: null,
    ocrWorkerLang: null,
    abortController: null
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
    bubbleCanvas: document.getElementById("bubbleCanvas")
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

function addToCache(key, val) {
    if (state.translationCache.size >= CONFIG.MAX_CACHE_SIZE) {
        const firstKey = state.translationCache.keys().next().value;
        state.translationCache.delete(firstKey);
    }
    state.translationCache.set(key, val);
}

// Fetch timeout bilan
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = CONFIG.FETCH_TIMEOUT_MS } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(resource, {
            ...options,
            signal: options.signal || controller.signal
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
    document.body.classList.remove("font-manga", "font-handwritten");
    
    if (fontType === "manga") {
        document.body.classList.add("font-manga");
    } else if (fontType === "handwritten") {
        document.body.classList.add("font-handwritten");
    }
    updateActiveButton(element);
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
// OCR WORKER (Boshqaruv & Terminate)
// ======================================

async function getOcrWorker() {
    const langMap = { en: "eng", ru: "rus", uz: "uzb" };
    const requiredLang = langMap[state.sourceLang] || "eng";

    // Agar worker mavjud bo'lsa-yu, tili o'zgargan bo'lsa, tozalaymiz
    if (state.ocrWorker && state.ocrWorkerLang !== requiredLang) {
        await terminateOcrWorker();
    }

    if (!state.ocrWorker) {
        setStatus("OCR dvigateli yuklanmoqda...");
        state.ocrWorker = await Tesseract.createWorker(requiredLang);
        state.ocrWorkerLang = requiredLang;
    }
    return state.ocrWorker;
}

async function terminateOcrWorker() {
    if (state.ocrWorker) {
        await state.ocrWorker.terminate();
        state.ocrWorker = null;
        state.ocrWorkerLang = null;
    }
}

async function recognizeText(imageSource) {
    const worker = await getOcrWorker();
    const result = await worker.recognize(imageSource);
    return result.data;
}

// ======================================
// TARJIMA ENGINE (Retry + Batch Parallel)
// ======================================

async function translateSingleText(text) {
    const cleaned = cleanText(text);
    if (!cleaned) return "";

    const cacheKey = `${state.sourceLang}_${state.targetLang}_${cleaned}`;
    if (state.translationCache.has(cacheKey)) {
        return state.translationCache.get(cacheKey);
    }

    let translated = null;

    // Retry mexanizmi bilan Google Translate
    for (let attempt = 0; attempt < CONFIG.TRANSLATE_MAX_RETRIES; attempt++) {
        if (state.abortController?.signal.aborted) break;
        try {
            translated = await translateViaGoogle(cleaned);
            if (translated) break;
        } catch (e) {
            await new Promise(r => setTimeout(r, CONFIG.TRANSLATE_RETRY_DELAY_MS));
        }
    }

    // Fallback: MyMemory
    if (!translated && !state.abortController?.signal.aborted) {
        translated = await translateViaMyMemory(cleaned);
    }

    const finalResult = translated || cleaned;
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

// Batch bo'yicha parallel tarjima qilish
async function translateBatch(blocks, onProgress) {
    const results = [];
    for (let i = 0; i < blocks.length; i += CONFIG.BATCH_SIZE) {
        if (state.abortController?.signal.aborted) break;
        
        const chunk = blocks.slice(i, i + CONFIG.BATCH_SIZE);
        const chunkPromises = chunk.map(block => {
            const txt = cleanText(block.text);
            return txt ? translateSingleText(txt) : Promise.resolve("");
        });

        const chunkResults = await Promise.all(chunkPromises);
        results.push(...chunkResults);

        if (onProgress) {
            onProgress((i + chunk.length) / blocks.length);
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
        await terminateOcrWorker(); // Memory Leak oldini olish
        setProcessingState(false);
    }
}

function clearDOMPreview() {
    if (DOM.results) DOM.results.textContent = "";
    if (DOM.pdfPreview) DOM.pdfPreview.textContent = "";
    if (DOM.ocrLayer) DOM.ocrLayer.textContent = "";
    if (DOM.previewArea) DOM.previewArea.classList.remove("hidden");
}

async function processPdfFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        if (state.abortController?.signal.aborted) break;

        setStatus(`PDF sahifasi ${pageNum}/${pdf.numPages} ishlanmoqda...`);

        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: CONFIG.PDF_SCALE });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: ctx, viewport }).promise;

        if (DOM.pdfPreview) DOM.pdfPreview.appendChild(canvas);

        // OCR jarayoni (Words orqali aniqroq bloklar olinadi)
        const ocrData = await recognizeText(canvas);
        const blocks = ocrData.blocks || ocrData.paragraphs || ocrData.lines || [];

        // Tarjima
        const translatedTexts = await translateBatch(blocks, (p) => {
            const pageProgress = ((pageNum - 1) + p) / pdf.numPages * 100;
            updateProgress(pageProgress);
        });

        // DOM ga xavfsiz chiqarish
        renderBlocksSafely(blocks, translatedTexts, viewport.width, viewport.height);

        // Xotirani darhol bo'shatish
        page.cleanup();
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

    renderBlocksSafely(blocks, translatedTexts, img.width, img.height);

    // RAM tozalash
    URL.revokeObjectURL(url);
    img.remove();
}

// Security: innerHTML o'rniga textContent
function renderBlocksSafely(blocks, translations, renderWidth, renderHeight) {
    if (!DOM.ocrLayer || !DOM.results) return;

    // Bounding Box hisoblash uchun konteynyer nisbati
    const containerWidth = DOM.pdfPreview.clientWidth || renderWidth;
    const scaleFactor = containerWidth / renderWidth;

    blocks.forEach((block, index) => {
        const translated = translations[index];
        const originalText = cleanText(block.text);
        if (!originalText || !translated) return;

        // 1. Matnli Card chiqarish (XSS protection)
        const card = document.createElement("div");
        card.className = "card";
        card.style.marginTop = "8px";

        const origP = document.createElement("p");
        origP.className = "result-card-text";
        origP.textContent = originalText;

        const transP = document.createElement("p");
        transP.className = "result-card-translated manga-text";
        transP.textContent = translated;

        card.appendChild(origP);
        card.appendChild(transP);
        DOM.results.appendChild(card);

        // 2. OCR Layer (Overlay Bubble) joylash
        if (block.bbox) {
            const box = block.bbox;
            const bubble = document.createElement("div");
            bubble.className = "ocr-bubble-text manga-text";
            
            // Scaled Koordinatalar
            bubble.style.left = `${box.x0 * scaleFactor}px`;
            bubble.style.top = `${box.y0 * scaleFactor}px`;
            bubble.style.width = `${(box.x1 - box.x0) * scaleFactor}px`;
            bubble.style.height = `${(box.y1 - box.y0) * scaleFactor}px`;
            bubble.textContent = translated;

            DOM.ocrLayer.appendChild(bubble);
        }
    });
}

// ======================================
// PDF EXPORT (Overlay bilan birga)
// ======================================

async function downloadTranslatedPdf() {
    if (!window.jspdf) {
        showError("jsPDF kutubxonasi yuklanmagan!");
        return;
    }

    const { jsPDF } = window.jspdf;
    const canvases = DOM.pdfPreview ? DOM.pdfPreview.querySelectorAll("canvas") : [];

    if (canvases.length === 0) {
        showError("Yuklab olish uchun rasm topilmadi.");
        return;
    }

    setStatus("Eksport uchun PDF tayyorlanmoqda...");
    const doc = new jsPDF();

    for (let i = 0; i < canvases.length; i++) {
        if (i > 0) doc.addPage();

        const srcCanvas = canvases[i];
        
        // processingCanvas dan foydalanib background va overlay-ni birlashtiramiz
        const exportCanvas = DOM.processingCanvas || document.createElement("canvas");
        exportCanvas.width = srcCanvas.width;
        exportCanvas.height = srcCanvas.height;
        const ctx = exportCanvas.getContext("2d");

        // 1. Asosiy manga tasvirini chizish
        ctx.drawImage(srcCanvas, 0, 0);

        // 2. Bubble text overlay elementlarini canvas ustiga chizish
        const bubbles = DOM.ocrLayer.querySelectorAll(".ocr-bubble-text");
        const scaleFactor = srcCanvas.width / (DOM.pdfPreview.clientWidth || srcCanvas.width);

        ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
        ctx.strokeStyle = "#000000";
        ctx.fillStyle = "#000000";
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";

        bubbles.forEach(b => {
            const left = parseFloat(b.style.left) * scaleFactor;
            const top = parseFloat(b.style.top) * scaleFactor;
            const width = parseFloat(b.style.width) * scaleFactor;
            const height = parseFloat(b.style.height) * scaleFactor;

            // Oq fon va ramka
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(left, top, width, height);
            ctx.strokeRect(left, top, width, height);

            // Matn
            ctx.fillStyle = "#000000";
            ctx.fillText(b.textContent, left + width / 2, top + height / 2 + 5, width);
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
window.startTranslation = toggleStartCancel;
window.setSourceLanguage = setSourceLanguage;
window.setTargetLanguage = setTargetLanguage;
window.setFont = setFont;
window.closeErrorModal = closeErrorModal;
window.downloadTranslatedPdf = downloadTranslatedPdf;
