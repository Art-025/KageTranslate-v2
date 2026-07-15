/*
=========================================
Kage Translate
main.js
Version 1.0
=========================================
*/

"use strict";

// ======================================
// GLOBAL VARIABLES
// ======================================

let selectedFiles = [];

let sourceLanguage = "en";

let targetLanguage = "uz";

let selectedFont = "manga";

let translationCache = {};

let ocrWorker = null;

// ======================================
// DOM ELEMENTS
// ======================================

const fileInput = document.getElementById("pdfInput");

const statusText = document.getElementById("statusText");

const goButton = document.getElementById("goBtn");

const resultArea = document.getElementById("results");

const progressBar = document.getElementById("progressBar");

// ======================================
// APP START
// ======================================

window.addEventListener("load", () => {

    console.log("Kage Translate Started");

});

// ======================================
// FILE SELECT
// ======================================

fileInput.addEventListener("change", (event) => {

    selectedFiles = Array.from(event.target.files);

    if(selectedFiles.length > 0){

        statusText.textContent =
        `${selectedFiles.length} ta fayl tanlandi.`;

        goButton.disabled = false;

    }else{

        statusText.textContent =
        "Fayl tanlanmagan.";

        goButton.disabled = true;

    }

});

// ======================================
// LANGUAGE SETTINGS
// ======================================

function setSourceLanguage(language){

    sourceLanguage = language;

    console.log("Original til:", sourceLanguage);

}

function setTargetLanguage(language){

    targetLanguage = language;

    console.log("Tarjima tili:", targetLanguage);

}

// ======================================
// START TRANSLATION
// ======================================

async function startTranslation(){

    if(selectedFiles.length === 0){

        alert("Iltimos, avval PDF yoki rasm tanlang.");

        return;

    }

    statusText.textContent =
    "Tarjima tayyorlanmoqda...";

    goButton.disabled = true;

// Eski natijalarni tozalash
resultArea.innerHTML = "";
progressBar.style.width = "0%";
progressBar.textContent = "0%";

// Eski tarjima cache ni tozalash
translationCache = {};

 try {

    for (const file of selectedFiles) {

        if (file.type === "application/pdf") {
            await processPdf(file);
        }
        else if (file.type.startsWith("image/")) {
            await processImage(file);
        }
        else {
            console.log("Qo'llab-quvvatlanmaydigan fayl:", file.name);
        }

    }

    statusText.textContent = "Fayllar tekshirildi.";

}
finally {

    goButton.disabled = false;

    if (ocrWorker !== null) {
        await ocrWorker.terminate();
        ocrWorker = null;
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

        statusText.textContent =
        `${pdf.numPages} ta sahifa topildi.`;

        return pdf;

    }catch(error){

        console.error("PDF Error:", error);

        alert("PDF faylni o'qib bo'lmadi.");

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
// INIT OCR WORKER
// ======================================

async function initOcrWorker(){

    if(ocrWorker !== null){
        return;
    }

    statusText.textContent =
    "OCR yuklanmoqda...";

    ocrWorker =
    await Tesseract.createWorker(sourceLanguage);

}

// ======================================
// OCR (TEXT RECOGNITION)
// ======================================

async function recognizeText(image){

    statusText.textContent = "Matn aniqlanmoqda...";

    await initOcrWorker();

    const { data } = await ocrWorker.recognize(image, {
        logger: (m) => {

            if (m.status === "recognizing text") {

                const percent = Math.round(m.progress * 100);

                progressBar.style.width = percent + "%";

                progressBar.textContent = percent + "%";

            }

        }
    });

    return data;

}

// ======================================
// TRANSLATE TEXT
// ======================================

async function translateText(text){

    text = text.trim();

    if(text === ""){
        return "";
    }

    // Cache tekshirish
    if(translationCache[text]){
        return translationCache[text];
    }

    statusText.textContent = "Tarjima qilinmoqda...";

    try{

        const url =
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLanguage}|${targetLanguage}`;

        const response = await fetch(url);

        // HTTP xatolarini tekshirish
        if(!response.ok){

            console.error("HTTP Error:", response.status);

            return text;

        }

        const data = await response.json();

        if(
            data.responseData &&
            data.responseData.translatedText &&
            data.responseData.translatedText.trim() !== ""
        ){

            const translated =
            data.responseData.translatedText;

            // Cache ga saqlash
            translationCache[text] = translated;

            return translated;

        }

        return text;

    }catch(error){

        console.error("Translation Error:", error);

        return text;

    }

}

// ======================================
// PROCESS PDF
// ======================================

async function processPdf(file){

    const pdf = await readPdf(file);

if(pdf === null){
    return;
}

    for(let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++){

        statusText.textContent =
        `Sahifa ${pageNumber}/${pdf.numPages} o'qilmoqda...`;

        const page = await pdf.getPage(pageNumber);

        const viewport = page.getViewport({ scale:2 });

        const canvas = document.createElement("canvas");

        const context = canvas.getContext("2d");

        canvas.width = viewport.width;

        canvas.height = viewport.height;

        await page.render({

            canvasContext:context,

            viewport:viewport

        }).promise;

        console.log("Sahifa tayyor:", pageNumber);
const textData = await recognizeText(canvas);

console.log(textData.text);

const translated = await translateText(textData.text);

console.log(translated);

const percent = Math.round((pageNumber / pdf.numPages) * 100);

progressBar.style.width = percent + "%";

progressBar.textContent = percent + "%";

resultArea.innerHTML += `
<div class="card">

<h3>Sahifa ${pageNumber}</h3>

<p><strong>Original:</strong></p>

<p>${textData.text}</p>

<hr>

<p><strong>Tarjima:</strong></p>

<p>${translated}</p>

</div>
`;

// Canvas xotirasini bo'shatish
canvas.width = 0;
canvas.height = 0;
page.cleanup();

    }

}

// ======================================
// PROCESS IMAGE
// ======================================

async function processImage(file){

    const image = await readImage(file);

    const textData = await recognizeText(image);

    console.log(
textData.text);

    const translated = await translateText(textData.text);

    console.log(translated);

progressBar.style.width = "100%";

progressBar.textContent = "100%";

resultArea.innerHTML += `
<div class="card">

<h3>Rasm</h3>

<p><strong>Original:</strong></p>

<p>${textData.text}</p>

<hr>

<p><strong>Tarjima:</strong></p>

<p>${translated}</p>

</div>

`;

}
