/* eslint-disable @typescript-eslint/no-require-imports */
// Generiert personas_24.xlsx mit allen 24 Persona-Kombinationen,
// passend zu generateCombinations() in src/app/page.tsx.
// Aufruf: node scripts/generate_personas_excel.js

const XLSX = require('xlsx');
const path = require('path');

// Erfahrungs-Range pro Rolle (Recherche Ole). Alter ist studienweit fix 20-29 Jahre.
const ROLES = [
  { rolle: 'CEM (Customer Experience Manager)', erfahrung: '5-7 Jahre' },
  { rolle: 'SMM (Social Media Manager)',        erfahrung: '2-5 Jahre' },
  { rolle: 'DMM (Digital Manager)',             erfahrung: '2-4 Jahre' },
  { rolle: 'Growth Manager',                    erfahrung: '2-4 Jahre' },
  { rolle: 'Kommunikation Manager',             erfahrung: '4-6 Jahre' },
  { rolle: 'Webseiten Manager',                 erfahrung: '5-7 Jahre' },
];

const GESCHLECHTER = ['Männlich', 'Weiblich'];
const PLZ_VARIANTEN = ['9000', '9403'];

const rows = [];
let id = 1;
for (const r of ROLES) {
  for (const g of GESCHLECHTER) {
    for (const plz of PLZ_VARIANTEN) {
      rows.push({
        ID: id++,
        Rolle: r.rolle,
        Geschlecht: g,
        Alter: '20-29 Jahre',
        Nationalitaet: 'Schweiz',
        Haushalt: '2 Personen 1 Kind',
        Ausbildung: 'Bachelor',
        Berufserfahrung: r.erfahrung,
        Wohnsitzland: 'Schweiz',
        Postleitzahl: plz,
      });
    }
  }
}

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(rows);

ws['!cols'] = [
  { wch: 4 },   // ID
  { wch: 36 },  // Rolle
  { wch: 11 },  // Geschlecht
  { wch: 13 },  // Alter
  { wch: 13 },  // Nationalitaet
  { wch: 22 },  // Haushalt
  { wch: 18 },  // Ausbildung
  { wch: 14 },  // Berufserfahrung
  { wch: 13 },  // Wohnsitzland
  { wch: 11 },  // Postleitzahl
];

XLSX.utils.book_append_sheet(wb, ws, 'Personas_24');

const outPath = path.join(__dirname, '..', 'personas_24.xlsx');
XLSX.writeFile(wb, outPath);
console.log(`Excel generiert: ${outPath} (${rows.length} Zeilen)`);
