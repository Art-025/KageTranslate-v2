/*
=========================================
Kage Translate
main.js
Version 1.5 (fixed)

O'ZGARISHLAR (v1.4 -> v1.5):
1. BUG TUZATILDI: getPdfTextLayer() endi barcha matnni bitta
   qatorga birlashtirmaydi - PDF elementlarining y-koordinatasiga
   qarab qatorlarga to'g'ri ajratadi. Shu tufayli split("\n")
   endi to'g'ri ishlaydi.
2. getPdfTextLayer() endi belgilar soni emas, items.length orqali
   "matn qatlami bormi" ekanini tekshiradi (qisqa "Yes." "No." kabi
   matnlar endi noto'g'ri OCR'ga yuborilmaydi).
3. Matn qatlamidan olingan paragraflar uchun confidence = null
   qo'yiladi (OCR bo'lmagani uchun "100% ishonch" degan noto'g'ri
   taassurot berilmaydi).
4. MAX_SAFE_PIXELS 25 mln -> 12 mln (eski/kuchsiz qurilmalarda
   Out Of Memory xavfini yanada kamaytiradi).
5. Paragraflarni saralashdagi ROW_THRESHOLD endi render scale'ga
   qarab moslashadi (scale=1 va scale=3 uchun bir xil piksel
   chegarasi ishlatilmaydi).
6. Progress endi Math.floor() bilan hisoblanadi - vizual jihatdan
   silliqroq ko'rinadi.
7. computeMinWordConfidence() endi word.confidence topilmasa
   word.conf ga ham qaraydi (Tesseract versiyalari farqi uchun).
8. translateLongText() endi:
   - juda uzun bitta jumla bo'lsa, uni ham so'zlar bo'yicha
     yana bo'lakларга bo'ladi (avval bitta 5000 belgili jumla
     bo'linmay qolardi);
   - jumlalar orasidagi original probel/yangi qator formatini
     saqlab qoladi (tarjimada dialog qatorlari aralashib ketmaydi).

Qasddan o'zgartirilmagan (arxitektura tanlovi, xato emas):
- beforeunload ichida terminate() kutilmaydi - brauzer bu yerda
  Promise'ni kuta olmaydi, bu "best-effort" yondashuv to'g'ri.
- translationCache har startTranslation() da tozalanadi - har bir
  tarjima sessiyasi mustaqil bo'lishi uchun ataylab shunday.

Keyingi bosqichga qoldirilgan: unicode punktuatsiya/harflar (ko'p
tillilik qo'shilganda), bubble detection, matnni rasm ustiga qayta
joylashtirish, yangi PDF yaratish.
=========================================
*/

"use strict";

// ======================================
// CONSTANTS
// ======================================

const DEBUG = true;

const TRANSLATE_TIMEOUT_MS = 10000;

const TRANSLATE_MAX_RETRIES = 2;

const TRANSLATE_RETRY_DELAY_MS = 800;

const OCR_PROGRESS_WEIGHT = 0.6;

const TRANSLATE_PROGRESS_WEIGHT = 0.4;

const MAX_CHUNK_LENGTH = 400;

const SCALE_LARGE_PAGE = 2;

const SCALE_NORMAL_PAGE = 3;

const LARGE_PAGE_THRESHOLD = 1500;

// Xavfsiz maksimal pixel soni (eski qurilmalar uchun ham xavfsiz)
const MAX_SAFE_PIXELS = 12_000_000;

const LOW_CONFIDENCE_THRESHOLD = 60;

// Qatorlarni ajratishda ishlatiladigan bazaviy piksel chegarasi (scale=1 uchun)
const ROW_THRESHOLD_BASE = 20;

// Matn qatlamida qator deb hisoblash uchun y-koordinata farqi tolerantligi
const TEXT_LAYER_Y_TOLERANCE = 2;

// ---- Tarjimani rasm/PDF ustiga chizish uchun sozlamalar ----

// Original matn o'rnini "tozalash" uchun fon rangi (haqiqiy bubble fonini
// aniqlamaymiz, shuning uchun oq eng ko'p uchraydigan holat sifatida tanlangan)
const TEXT_OVERLAY_BG = "#ffffff";

const TEXT_OVERLAY_TEXT_COLOR = "#111111";

const MIN_OVERLAY_FONT_SIZE = 10;

const MAX_OVERLAY_FONT_SIZE = 42;

// selectedFont qiymatiga mos canvas shrift satrlari
const OVERLAY_FONT_MAP = {
    normal: "Arial, Helvetica, sans-serif",
    manga: "'Bangers', 'Arial Black', Impact, sans-serif",
    handwritten: "'Caveat', 'Comic Sans MS', cursive"
};

// Chiqarilgan sahifa rasmlari uchun JPEG sifati (0-1)
const OUTPUT_IMAGE_QUALITY = 0.92;

// ======================================
// GLOBAL VARIABLES
// ======================================

let selectedFiles = [];

let sourceLanguage = "en";

let targetLanguage = "uz";

let selectedFont = "manga";

let translationCache = new Map();

let ocrWorker = null;

let ocrWorkerLanguage = null;

// PDF yaratish uchun saqlanadigan tarjimalar
let translatedPages = [];

// Oxirgi tarjima qilingan fayl nomi
let translatedFileName = "";

// Har bir tarjima qilingan sahifa/rasmning yakuniy tasviri shu yerda yig'iladi
// (yangi PDF yaratish va ulashish uchun ishlatiladi)
let translatedPageImages = [];

// ======================================
// DOM ELEMENTS
// ======================================

const fileInput = document.getElementById("pdfInput");

const statusText = document.getElementById("statusText");

const goButton = document.getElementById("goBtn");

const resultArea = document.getElementById("results");

const progressBar = document.getElementById("progressBar");

const loadingSpinner = document.getElementById("loadingSpinner");

const downloadButton = document.getElementById("downloadBtn");

const shareButton = document.getElementById("shareBtn");

const GO_BUTTON_DEFAULT_LABEL = "Tarjima qilishni boshlash";

// ======================================
// APP START
// ======================================

window.addEventListener("load", () => {

    log("Kage Translate Started");

    const defaultEnglishBtn = document.getElementById("englishBtn");
    if(defaultEnglishBtn) setActiveButton(defaultEnglishBtn);

    const defaultTargetBtn = document.getElementById("targetUzBtn");
    if(defaultTargetBtn) setActiveButton(defaultTargetBtn);

    const defaultFontBtn = document.querySelector('button[onclick*="setFont(\'manga\'"]');
    if(defaultFontBtn) setActiveButton(defaultFontBtn);

});

// Sahifa yopilganda OCR workerni tugatishga urinish (best-effort;
// brauzer bu yerda Promise tugashini kutmaydi, bu normal holat).
window.addEventListener("beforeunload", () => {

    if(ocrWorker !== null){

        ocrWorker.terminate();

    }

});

// ======================================
// HELPERS
// ======================================

function log(...args){

    if(DEBUG){
        console.log(...args);
    }

}

function setStatus(text){

    if(statusText){
        statusText.textContent = text;
    }

    log(text);

}

function sleep(ms){

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function sanitizeConfidence(value){

    if(typeof value !== "number") return null;

    if(!Number.isFinite(value)) return null;

    if(value < 0 || value > 100) return null;

    return value;

}

function normalizeForCache(text){

    return text
        .replace(/[\u00A0\u3000]/g, " ")
        .trim()
        .toLowerCase()
        .replace(/(\.{3,}|…|・{2,})/g, "...")
        .replace(/[.!?？！。、,]+$/g, "")
        .replace(/\s+/g, " ");

}

function cleanOcrText(text){

    return (text ?? "")
        .replace(/([a-zA-Z])-\n([a-zA-Z])/g, "$1$2")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

}

function updateOverallProgress(itemIndex, totalItems, itemFraction){

    if(!progressBar) return;

    const clampedFraction = Math.max(0, Math.min(1, itemFraction));

    const overall = ((itemIndex + clampedFraction) / totalItems) * 100;

    const percent = Math.max(0, Math.min(100, Math.floor(overall)));

    progressBar.style.width = percent + "%";

    progressBar.textContent = percent + "%";

    progressBar.setAttribute("aria-valuenow", percent);

}

function getRenderScale(page){

    const baseViewport = page.getViewport({ scale: 1 });

    let scale = Math.max(baseViewport.width, baseViewport.height) > LARGE_PAGE_THRESHOLD
        ? SCALE_LARGE_PAGE
        : SCALE_NORMAL_PAGE;

    let pixels = (baseViewport.width * scale) * (baseViewport.height * scale);

    while(pixels > MAX_SAFE_PIXELS && scale > 1){

        scale -= 0.5;

        pixels = (baseViewport.width * scale) * (baseViewport.height * scale);

    }

    return scale;

}

// Matnni jumlalarga bo'lish, har birining ORIGINAL bo'shliq/yangi qator
// formatini saqlagan holda (dialog qatorlari aralashib ketmasligi uchun)
function splitIntoSentences(text){

    const matches = text.match(/[^.!?]+[.!?]*\s*/g);

    if(!matches) return [text];

    return matches.filter((s) => s.trim() !== "");

}

// Bitta jumla ham juda uzun bo'lsa, so'zlar bo'yicha yana bo'laklarga bo'lish
function splitLongChunk(text, maxLen){

    if(text.length <= maxLen) return [text];

    const words = text.split(" ");

    const chunks = [];

    let current = "";

    for(const word of words){

        const candidate = current === "" ? word : current + " " + word;

        if(candidate.length > maxLen && current !== ""){

            chunks.push(current);

            current = word;

        }else{

            current = candidate;

        }

    }

    if(current !== ""){
        chunks.push(current);
    }

    return chunks;

}

// Paragraflarni bbox bo'yicha o'qish tartibiga saralash.
// scale - qanday render scale'da OCR qilinganini bildiradi (rasmlar uchun 1).
function sortParagraphsByReadingOrder(paragraphs, scale = 1){

    const rowThreshold = ROW_THRESHOLD_BASE * scale;

    return paragraphs.slice().sort((a, b) => {

        if(!a.bbox || !b.bbox) return 0;

        const dy = a.bbox.y0 - b.bbox.y0;

        if(Math.abs(dy) > rowThreshold){
            return dy;
        }

        return a.bbox.x0 - b.bbox.x0;

    });

}

// Paragraf ichidagi eng past so'z aniqligini topish (Tesseract versiyasiga qarab
// word.confidence yoki word.conf bo'lishi mumkin)
function computeMinWordConfidence(para){

    let min = null;

    if(!para.lines) return null;

    for(const line of para.lines){

        if(!line.words) continue;

        for(const word of line.words){

            const rawConfidence = word.confidence ?? word.conf;

            const c = sanitizeConfidence(rawConfidence);

            if(c !== null && (min === null || c < min)){
                min = c;
            }

        }

    }

    return min;

}

// ======================================
// FILE SELECT
// ======================================

if(fileInput){

    fileInput.addEventListener("change", (event) => {

        selectedFiles = Array.from(event.target.files);

        if(selectedFiles.length > 0){

            setStatus(`${selectedFiles.length} ta fayl tanlandi.`);

            if(goButton){
                goButton.disabled = false;
                goButton.textContent = GO_BUTTON_DEFAULT_LABEL;
            }

        }else{

            setStatus("Fayl tanlanmagan.");

            if(goButton) goButton.disabled = true;

        }

    });

}

// Bosilgan tugmani "active" qilib, shu guruhdagi boshqalarini tozalash
function setActiveButton(buttonEl){

    if(!buttonEl) return;

    const group = buttonEl.parentElement;

    if(!group) return;

    group.querySelectorAll("button").forEach((btn) => btn.classList.remove("active"));

    buttonEl.classList.add("active");

}

// ======================================
// LANGUAGE / FONT SETTINGS
// ======================================

function setSourceLanguage(language, buttonEl){

    sourceLanguage = language;

    setActiveButton(buttonEl);

    log("Original til:", sourceLanguage);

}

function setTargetLanguage(language, buttonEl){

    targetLanguage = language;

    setActiveButton(buttonEl);

    log("Tarjima tili:", targetLanguage);

}

function setFont(fontName, buttonEl){

    selectedFont = fontName;

    setActiveButton(buttonEl);

    log("Font:", selectedFont);

}

// ======================================
// START TRANSLATION
// ======================================

async function startTranslation(){

    if(selectedFiles.length === 0){

        alert("Iltimos, avval PDF yoki rasm tanlang.");

        return;

    }

    setStatus("Tarjima tayyorlanmoqda...");

    if(goButton){
        goButton.disabled = true;
        goButton.textContent = "Tarjima qilinmoqda...";
    }

    if(loadingSpinner) loadingSpinner.hidden = false;

    if(resultArea) resultArea.innerHTML = "";

    if(progressBar){
        progressBar.style.width = "0%";
        progressBar.textContent = "0%";
        progressBar.setAttribute("aria-valuenow", "0");
    }

    translationCache = new Map();

    try {

        for (const file of selectedFiles) {

            if (file.type === "application/pdf") {
                await processPdf(file);
            }
            else if (file.type.startsWith("image/")) {
                await processImage(file);
            }
            else {

                log("Qo'llab-quvvatlanmaydigan fayl:", file.name);

                if(resultArea){
                    resultArea.appendChild(
                        createMessageCard(`"${file.name}" fayli qo'llab-quvvatlanmaydi.`, "card-error")
                    );
                }

            }

        }

        setStatus("Tarjima yakunlandi.");

        if(goButton) goButton.textContent = "Tarjima tugadi ✅";

    }
    catch(error){

        console.error("Tarjima jarayonida xato:", error);

        setStatus("Xatolik yuz berdi. Konsolni tekshiring.");

        if(goButton) goButton.textContent = "Xatolik yuz berdi";

    }
    finally {

        if(goButton) goButton.disabled = false;

        if(loadingSpinner) loadingSpinner.hidden = true;

    }

}

// ======================================
// READ PDF FILE
// ======================================

async function readPdf(file){

    try{

        const arrayBuffer = await file.arrayBuffer();

        const pdf = await pdfjsLib.getDocument({
            data: arrayBuffer
        }).promise;

        setStatus(`${pdf.numPages} ta sahifa topildi.`);

        return pdf;

    }catch(error){

        console.error("PDF Error:", error);

        alert("PDF faylni o'qib bo'lmadi.");

        return null;

    }

}

// PDF sahifasidagi matn qatlamini o'qishga urinish (OCR shart bo'lmasligi uchun).
// Elementlar y-koordinatasiga qarab qatorlarga to'g'ri ajratiladi.
async function getPdfTextLayer(page){

    try{

        const content = await page.getTextContent();

        const items = content.items || [];

        if(items.length === 0){
            return null;
        }

        const lines = [];

        let currentLine = "";

        let lastY = null;

        for(const item of items){

            const y = item.transform ? item.transform[5] : null;

            const isNewLine =
                lastY !== null &&
                y !== null &&
                Math.abs(y - lastY) > TEXT_LAYER_Y_TOLERANCE;

            if(isNewLine && currentLine.trim() !== ""){

                lines.push(currentLine.trim());

                currentLine = "";

            }

            currentLine += item.str + " ";

            if(item.hasEOL){

                lines.push(currentLine.trim());

                currentLine = "";

            }

            lastY = y;

        }

        if(currentLine.trim() !== ""){
            lines.push(currentLine.trim());
        }

        const fullText = lines.join("\n").trim();

        return fullText.length > 0 ? fullText : null;

    }catch(error){

        console.error("Text layer xatosi:", error);

        return null;

    }

}

// ======================================
// READ IMAGE
// ======================================

function readImage(file){

    return new Promise((resolve,reject)=>{

        const image = new Image();

        const imageUrl = URL.createObjectURL(file);

        image.onload = ()=>{

            URL.revokeObjectURL(imageUrl);

            resolve(image);

        };

        image.onerror = ()=>{

            URL.revokeObjectURL(imageUrl);

            reject(new Error("Rasmni yuklab bo'lmadi."));

        };

        image.src = imageUrl;

    });

                                          }

// ======================================
// INIT OCR WORKER (sessiya davomida qayta ishlatiladi)
// ======================================

async function initOcrWorker(){

    if(ocrWorker !== null && ocrWorkerLanguage === sourceLanguage){
        return;
    }

    if(ocrWorker !== null){

        await ocrWorker.terminate();

        ocrWorker = null;

        ocrWorkerLanguage = null;

    }

    setStatus("OCR yuklanmoqda...");

    ocrWorker = await Tesseract.createWorker(sourceLanguage);

    ocrWorkerLanguage = sourceLanguage;

}

// ======================================
// OCR (TEXT RECOGNITION)
// ======================================

async function recognizeText(image, onOcrProgress){

    setStatus("Matn aniqlanmoqda...");

    await initOcrWorker();

    const { data } = await ocrWorker.recognize(
        image,
        {
            logger: (m) => {

                if(m.status === "recognizing text" && typeof onOcrProgress === "function"){

                    onOcrProgress(m.progress);

                }

            }
        },
        { blocks: true, text: true }
    );

    return data;

}

// Paragraflarni ajratib olish: { text, confidence, minWordConfidence, bbox }
function extractParagraphs(data, scale = 1){

    const paragraphs = [];

    if(data.blocks && data.blocks.length > 0){

        for(const block of data.blocks){

            if(!block.paragraphs) continue;

            for(const para of block.paragraphs){

                const text = cleanOcrText(para.text || "");

                if(text === "") continue;

                paragraphs.push({
                    text,
                    confidence: sanitizeConfidence(para.confidence),
                    minWordConfidence: computeMinWordConfidence(para),
                    bbox: para.bbox || null
                });

            }

        }

    }

    if(paragraphs.length === 0 && data.text && data.text.trim() !== ""){

        paragraphs.push({
            text: cleanOcrText(data.text),
            confidence: sanitizeConfidence(data.confidence),
            minWordConfidence: null,
            bbox: null
        });

    }

    return sortParagraphsByReadingOrder(paragraphs, scale);

}

// ======================================
// TRANSLATE
// ======================================

// ---- Tarjima provayderlari: Google (asosiy) -> MyMemory (zaxira) ----
// Google norasmiy endpoint vaqti-vaqti bilan 429/503 qaytarishi yoki
// butunlay bloklanishi mumkin. Shuning uchun bitta provayderga
// bog'lanib qolmaslik uchun zaxira sifatida MyMemory ham saqlanadi.

function buildGoogleTranslateUrl(text){

    return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLanguage}&tl=${targetLanguage}&dt=t&q=${encodeURIComponent(text)}`;

}

function parseGoogleTranslateResponse(data){

    // Javob formati: [[["tarjima1","original1",...], ["tarjima2","original2",...], ...], ...]
    if(Array.isArray(data) && Array.isArray(data[0])){

        const translated = data[0]
            .map((part) => (Array.isArray(part) ? part[0] : ""))
            .join("");

        if(translated.trim() !== ""){
            return translated;
        }

    }

    return null;

}

function buildMyMemoryUrl(text){

    return `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLanguage}|${targetLanguage}`;

}

function parseMyMemoryResponse(data){

    if(
        data.responseData &&
        data.responseData.translatedText &&
        data.responseData.translatedText.trim() !== ""
    ){
        return data.responseData.translatedText;
    }

    return null;

}

async function fetchJsonWithTimeout(url, timeoutMs){

    const controller = new AbortController();

    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try{

        const response = await fetch(url, { signal: controller.signal });

        clearTimeout(timeoutId);

        if(!response.ok){
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();

    }catch(error){

        clearTimeout(timeoutId);

        throw error;

    }

}

// Bitta provayderni retry bilan sinab ko'rish. Barcha urinishlar
// tugasa, xatoni yuqoriga (chaqiruvchiga) tashlaydi - shunda
// translateChunk() keyingi provayderga o'tishi mumkin.
async function translateViaProvider(text, buildUrl, parseResponse, retriesLeft){

    try{

        const data = await fetchJsonWithTimeout(buildUrl(text), TRANSLATE_TIMEOUT_MS);

        const result = parseResponse(data);

        if(result !== null){
            return result;
        }

        throw new Error("Bo'sh yoki noto'g'ri javob");

    }catch(error){

        console.error("Tarjima provayder xatosi:", error.message);

        if(retriesLeft > 0){

            await sleep(TRANSLATE_RETRY_DELAY_MS);

            return translateViaProvider(text, buildUrl, parseResponse, retriesLeft - 1);

        }

        throw error;

    }

}

async function translateChunk(text){

    try{

        return await translateViaProvider(
            text,
            buildGoogleTranslateUrl,
            parseGoogleTranslateResponse,
            TRANSLATE_MAX_RETRIES
        );

    }catch(googleError){

        log("Google Translate ishlamadi, MyMemory zaxira provayderga o'tilmoqda...");

        try{

            return await translateViaProvider(
                text,
                buildMyMemoryUrl,
                parseMyMemoryResponse,
                TRANSLATE_MAX_RETRIES
            );

        }catch(myMemoryError){

            console.error("Barcha tarjima provayderlari ishlamadi, original matn qaytarilmoqda.");

            return text;

        }

    }

}

async function translateText(text){

    text = (text ?? "").trim();

    if(text === ""){
        return "";
    }

    const cacheKey = normalizeForCache(text);

    if(translationCache.has(cacheKey)){
        return translationCache.get(cacheKey);
    }

    setStatus("Tarjima qilinmoqda...");

    const translated = await translateChunk(text);

    translationCache.set(cacheKey, translated);

    return translated;

}

// Uzun matnni jumlalarga (kerak bo'lsa yana bo'laklarga) bo'lib tarjima qilish,
// original probel/yangi-qator formatini saqlagan holda.
async function translateLongText(text){

    if(text.length <= MAX_CHUNK_LENGTH){

        return translateText(text);

    }

    const sentences = splitIntoSentences(text);

    const translatedParts = [];

    for(const sentence of sentences){

        const trimmedSentence = sentence.trim();

        if(trimmedSentence === "") continue;

        const trailingWhitespace = sentence.slice(sentence.trimEnd().length);

        const separator = trailingWhitespace.includes("\n") ? "\n" : " ";

        let translatedSentence;

        if(trimmedSentence.length > MAX_CHUNK_LENGTH){

            // Bitta jumlaning o'zi ham juda uzun - so'zlar bo'yicha yana bo'lamiz
            const subChunks = splitLongChunk(trimmedSentence, MAX_CHUNK_LENGTH);

            const subTranslated = [];

            for(const chunk of subChunks){

                subTranslated.push(await translateText(chunk));

            }

            translatedSentence = subTranslated.join(" ");

        }else{

            translatedSentence = await translateText(trimmedSentence);

        }

        translatedParts.push(translatedSentence + separator);

    }

    return translatedParts.join("").trim();

}

// ======================================
// DOM RENDER HELPERS
// ======================================

function createMessageCard(message, extraClass){

    const card = document.createElement("div");

    card.className = "card" + (extraClass ? " " + extraClass : "");

    const p = document.createElement("p");

    p.textContent = message;

    card.appendChild(p);

    return card;

}

function createPageCard(titleText){

    const card = document.createElement("div");

    card.className = "card";

    const h3 = document.createElement("h3");

    h3.textContent = titleText;

    card.appendChild(h3);

    return card;

}

function createParagraphBlock(index, original, translated, confidence){

    const lowConfidence = confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD;

    const wrapper = document.createElement("div");

    wrapper.className = "paragraph-block" + (lowConfidence ? " low-confidence" : "");

    const indexEl = document.createElement("div");

    indexEl.className = "paragraph-index";

    indexEl.textContent = `#${index}`;

    wrapper.appendChild(indexEl);

    if(lowConfidence){

        const badge = document.createElement("span");

        badge.className = "badge-warning";

        badge.textContent = `⚠️ past aniqlik (${Math.round(confidence)}%)`;

        wrapper.appendChild(badge);

    }

    const originalP = document.createElement("p");

    originalP.className = "original-text";

    const originalLabel = document.createElement("strong");

    originalLabel.textContent = "Original: ";

    originalP.appendChild(originalLabel);

    originalP.appendChild(document.createTextNode(original));

    wrapper.appendChild(originalP);

    const translatedP = document.createElement("p");

    translatedP.className = `translated-text font-${selectedFont}`;

    const translatedLabel = document.createElement("strong");

    translatedLabel.textContent = "Tarjima: ";

    translatedP.appendChild(translatedLabel);

    translatedP.appendChild(document.createTextNode(translated));

    wrapper.appendChild(translatedP);

    return wrapper;

}

function createEmptyNote(message){

    const p = document.createElement("p");

    p.className = "empty-note";

    p.textContent = message;

    return p;

}

async function translateAndRenderParagraphs(paragraphs, itemIndex, totalItems){

    const fragment = document.createDocumentFragment();

    if(paragraphs.length === 0){

        fragment.appendChild(createEmptyNote("Matn topilmadi."));

        updateOverallProgress(itemIndex, totalItems, 1);

        return fragment;

    }

    for(let i = 0; i < paragraphs.length; i++){

        const para = paragraphs[i];

        const translated = await translateLongText(para.text);

        const effectiveConfidence = para.minWordConfidence ?? para.confidence ?? null;

        fragment.appendChild(
            createParagraphBlock(i + 1, para.text, translated, effectiveConfidence)
        );

        const translateFraction = (i + 1) / paragraphs.length;

        updateOverallProgress(
            itemIndex,
            totalItems,
            OCR_PROGRESS_WEIGHT + translateFraction * TRANSLATE_PROGRESS_WEIGHT
        );

    }

    return fragment;

}

// ======================================
// PROCESS PDF (har sahifa alohida himoyalangan)
// ======================================

async function processPdf(file){

    const pdf = await readPdf(file);

    if(pdf === null){
        return;
    }

    for(let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++){

        const pageIndex = pageNumber - 1;

        let page = null;

        let canvas = null;

        let context = null;

        try{

            setStatus(`Sahifa ${pageNumber}/${pdf.numPages} o'qilmoqda...`);

            page = await pdf.getPage(pageNumber);

            let paragraphs;

            const textLayerText = await getPdfTextLayer(page);

            if(textLayerText){

                log(`Sahifa ${pageNumber}: matn qatlami topildi, OCR o'tkazib yuborildi.`);

                paragraphs = textLayerText
                    .split("\n")
                    .map((t) => cleanOcrText(t))
                    .filter((t) => t !== "")
                    .map((t) => ({
                        text: t,
                        confidence: null,
                        minWordConfidence: null,
                        bbox: null
                    }));

                updateOverallProgress(pageIndex, pdf.numPages, OCR_PROGRESS_WEIGHT);

            }else{

                const scale = getRenderScale(page);

                const viewport = page.getViewport({ scale });

                canvas = document.createElement("canvas");

                context = canvas.getContext("2d");

                canvas.width = viewport.width;

                canvas.height = viewport.height;

                await page.render({

                    canvasContext: context,

                    viewport: viewport

                }).promise;

                log(`Sahifa tayyor: ${pageNumber} (scale=${scale})`);

                const textData = await recognizeText(canvas, (ocrFraction) => {

                    updateOverallProgress(pageIndex, pdf.numPages, ocrFraction * OCR_PROGRESS_WEIGHT);

                });

                paragraphs = extractParagraphs(textData, scale);

            }

            log(`Sahifa ${pageNumber}: ${paragraphs.length} ta paragraf topildi.`);

            const pageCard = createPageCard(`Sahifa ${pageNumber}`);

            const fragment = await translateAndRenderParagraphs(paragraphs, pageIndex, pdf.numPages);

            pageCard.appendChild(fragment);

            if(resultArea){
                resultArea.appendChild(pageCard);
            }

        }catch(error){

            console.error(`Sahifa ${pageNumber} da xato:`, error);

            if(resultArea){

                resultArea.appendChild(
                    createMessageCard(
                        `Sahifa ${pageNumber} ni qayta ishlashda xato yuz berdi. Qolgan sahifalar davom etmoqda.`,
                        "card-error"
                    )
                );

            }

            updateOverallProgress(pageIndex, pdf.numPages, 1);

        }finally{

            if(canvas){
                canvas.width = 0;
                canvas.height = 0;
            }

            context = null;

            if(page){
                page.cleanup();
            }

        }

    }

}

// ======================================
// PROCESS IMAGE
// ======================================

async function processImage(file){

    try{

        const image = await readImage(file);

        const textData = await recognizeText(image, (ocrFraction) => {

            updateOverallProgress(0, 1, ocrFraction * OCR_PROGRESS_WEIGHT);

        });

        const paragraphs = extractParagraphs(textData);

        log(`Rasm: ${paragraphs.length} ta paragraf topildi.`);

        const pageCard = createPageCard("Rasm");

        const fragment = await translateAndRenderParagraphs(paragraphs, 0, 1);

        pageCard.appendChild(fragment);

        if(resultArea){
            resultArea.appendChild(pageCard);
        }

    }catch(error){

        console.error("Rasmni qayta ishlashda xato:", error);

        if(resultArea){

            resultArea.appendChild(
                createMessageCard("Rasmni qayta ishlashda xato yuz berdi.", "card-error")
            );

        }

    }

}

// ======================================
// INLINE onclick UCHUN GLOBAL QILISH
// ======================================

window.startTranslation = startTranslation;
window.setSourceLanguage = setSourceLanguage;
window.setTargetLanguage = setTargetLanguage;
window.setFont = setFont;                 
