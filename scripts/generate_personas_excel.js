/* eslint-disable @typescript-eslint/no-require-imports */
// Generiert personas_24.xlsx mit allen 24 Persona-Kombinationen,
// passend zu generateCombinations() in src/app/page.tsx.
// Aufruf: node scripts/generate_personas_excel.js

const XLSX = require('xlsx');
const path = require('path');

const ROLES = [
  {
    rolle: 'CEM (Customer Experience Manager)',
    alter: '23-26 Jahre',
    erfahrung: '5-7 Jahre',
  },
  {
    rolle: 'SMM (Social Media Manager)',
    alter: '25-31 Jahre',
    erfahrung: '2-5 Jahre',
  },
  {
    rolle: 'DMM (Digital Manager)',
    alter: '22-28 Jahre',
    erfahrung: '2-4 Jahre',
  },
  {
    rolle: 'Growth Manager',
    alter: '26-30 Jahre',
    erfahrung: '2-4 Jahre',
  },
  {
    rolle: 'Kommunikation Manager',
    alter: '22-25 Jahre',
    erfahrung: '4-6 Jahre',
  },
  {
    rolle: 'Webseiten Manager',
    alter: '24-28 Jahre',
    erfahrung: '5-7 Jahre',
  },
];

const GESCHLECHTER = ['Männlich', 'Weiblich'];
const HAUSHALTE = ['1 Person kein Kind', '2 Personen 1 Kind'];

const rows = [];
let id = 1;
for (const r of ROLES) {
  for (const g of GESCHLECHTER) {
    for (const h of HAUSHALTE) {
      rows.push({
        ID: id++,
        Rolle: r.rolle,
        Geschlecht: g,
        Alter: r.alter,
        Nationalitaet: 'Schweiz',
        Haushalt: h,
        Ausbildung: 'Bachelor / Master',
        Berufserfahrung: r.erfahrung,
        Wohnsitzland: 'Schweiz',
        Postleitzahl: '9000',
      });
    }
  }
}

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(rows);

// Spaltenbreiten setzen, damit die Ausgabe direkt lesbar ist.
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
