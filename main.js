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

// ======================================
// DOM ELEMENTS
// ======================================

const fileInput = document.getElementById("pdfInput");

const statusText = document.getElementById("statusText");

const goButton = document.getElementById("goBtn");

const resultArea = document.getElementById("results");

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

    console.log(selectedFiles);

}
