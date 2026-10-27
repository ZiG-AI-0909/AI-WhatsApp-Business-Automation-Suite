'use strict';

// Proforma invoice defaults: the exporter profile (company, bank, standard
// terms, shipping defaults, numbering), a blank invoice built from a
// profile, and the reference invoice (Alfatth_26-27/PI-03R5) as a
// "load sample" for demonstration.
//
// The profile here is only the factory default. Each tenant can save its
// own copy (proforma_profiles), so company or bank changes never need a
// code change.
//
// Terms text may use **bold** and {tokens}; see proformaCalculation.TOKENS.

const CURRENCIES = {
    USD: { code: 'USD', words: 'United States Dollars', minor: 'Cents' },
    EUR: { code: 'EUR', words: 'Euros', minor: 'Cents' },
    GBP: { code: 'GBP', words: 'Pounds Sterling', minor: 'Pence' },
    AED: { code: 'AED', words: 'UAE Dirhams', minor: 'Fils' },
};

const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

// Wording copied from the reference invoice as supplied (including its
// spelling); edit per invoice or in the saved profile, never here silently.
const DEFAULT_TERMS = [
    { title: 'Price Validity', text: 'The prices are **valid** for 7 days from the date of Proforma Invoice.' },
    { title: 'INCO Terms', text: '{incoterm} {incoterm_place}' },
    { title: 'Extra Charges (Other than INCO Terms)', text: 'Import duties, inland freight, insurance, and any other applicable duties and charges are to be borne by the customer. These charges are in addition to the above-mentioned price of the goods.' },
    { title: 'Payment Terms', text: '**{currency} {advance} advance** along with confirmed purchase order and the **balance** amount of **{currency} {balance}** payable against a scanned copy of draft Bill of Lading (BL).' },
    { title: 'Bank Charges', text: "Any bank or commission charges incurred for the transfer of funds will be charged to customer's account." },
    { title: 'Inspection', text: 'Any inspections required for the goods will be charged separately and are to be borne by the buyer.' },
    { title: 'Beneficiary Details', text: 'Payment to be made to: M/s Sudarshan Extrusions Pvt. Ltd.' },
    { title: 'Advising Bank Details', text: '{bank_name}, {bank_branch}\nAccount No.: **{bank_account}** SWIFT Code: **{bank_swift}** IFSC: {bank_ifsc}' },
    { title: 'Variance Clause', text: 'The final quantities and total values of the goods to be shipped may vary by up to **±10%** based on actual space availability in the container. The Overall Length of each Pipe will be 3.0 meters (**±50 mm**). Coupler is additionally fitted.' },
    { title: 'Shipment Terms', text: 'Shipment within **30 to 40 working days** from receipt of confirmed PO, advance payment and all import-related approvals. Partial shipment and transhipment are allowed. Shipment by a non-conference vessel is acceptable. Telescopic stuffing is permitted.' },
    { title: 'Origin of Goods (Country)', text: 'The Goods listed in this Proforma Invoice are of Indian Origin.' },
    { title: 'Force Majeure', text: 'Applicable due to natural disasters, war, strikes, government actions, or other unforeseeable circumstances.' },
    { title: 'Freight Charges #', text: 'Ocean freight being **reviewed** with the service provider and will be **charged at actual** in the final invoice at the time of shipment. **Any War Risk / Emergency Charges** will be charged extra at actuals incurred at any point till the arrival of consignemnt to the port of destination.' },
];

const DEFAULT_PROFILE = {
    exporter: {
        name: 'M/s. Sudarshan Extrusions Pvt. Ltd.',
        address: '105, Phase IV, Bommasandra Industrial Area, Hosur Road\nBangalore - 560099, Karnataka, India',
        contact_person: 'Mr. Aayush Salampuria',
        phone: '+91 97423 50063',
        gstin: '29AACCK1590L1Z6',
        iec: '0705014487',
        signatory_name: 'Sudarshan Extrusions Pvt. Ltd.',
    },
    bank: {
        name: 'State Bank of India',
        branch: 'Electronic City Branch, Bangalore, India',
        account: '37365498723',
        swift: 'SBININBBA32',
        ifsc: 'SBIN0063971',
    },
    shipping: {
        pre_carriage: 'Road',
        place_of_receipt: 'Bangalore / Chennai Port, India',
        port_of_loading: 'Chennai Port, India',
        origin_country: 'INDIA',
        incoterm: 'CFR',
    },
    inland_freight: { description: 'Inland Freight (Ex Works - Bangalore to Chennai Port, India)', unit: 'Container' },
    ocean_freight_unit: 'Container',
    payment_summary: '**Payment: {currency} {advance} advance** along with confirmed purchase order and the **balance amount of {currency} {balance}** payable against a scanned copy of the draft Bill of Lading (B/L)',
    enquiry_ref: 'Based on WhatsApp correspondence & subsequent telephonic discussions',
    product_group: 'PVC Pipes - uPVC Column Pipes',
    terms: DEFAULT_TERMS,
    // {prefix} {fy} (26-27, April-March) {seq}; seq_digits pads {seq}.
    numbering: { pattern: '{prefix}_{fy}/PI-{seq}', prefix: '', seq_digits: 2 },
};

let idCounter = 0;
function newId(prefix = 'r') {
    idCounter = (idCounter + 1) % 1e6;
    return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function blankItem(profile = DEFAULT_PROFILE) {
    return { id: newId('i'), description: profile.product_group || '', size: '', specification: '', pressure: '', coupler: '', length: 3, hsn: '39172390', qty: '', rate: '' };
}

// A new invoice carries the exporter's company, bank, terms and shipping
// defaults; the parties, products and numbers start empty.
function blankInvoice(profile = DEFAULT_PROFILE, today = new Date().toISOString().slice(0, 10)) {
    const p = mergeProfile(profile);
    return {
        invoice: { number: '', date: today, enquiry_ref: p.enquiry_ref, po_number: '', po_date: '', currency: 'USD' },
        exporter: { ...p.exporter },
        consignee: { name: '', address: '', country: '', tax_id: '', acid: '', email: '', phone: '' },
        buyer: { same_as_consignee: false, name: '', address: '', country: '', tax_id: '', email: '', contact_person: '', phone: '' },
        shipping: {
            pre_carriage: p.shipping.pre_carriage,
            place_of_receipt: p.shipping.place_of_receipt,
            place_of_delivery: '',
            container_no: '',
            vessel_no: '',
            port_of_loading: p.shipping.port_of_loading,
            port_of_discharge: '',
            origin_country: p.shipping.origin_country,
            destination_country: '',
            incoterm: p.shipping.incoterm,
            incoterm_place: '',
            delivery_terms: '',
        },
        payment: { advance: '', summary: p.payment_summary },
        bank: { ...p.bank },
        items: [blankItem(p)],
        inland_freight: { include: true, description: p.inland_freight.description, unit: p.inland_freight.unit, qty: '', rate: '' },
        ocean_freight: { include: true, description: '', unit: p.ocean_freight_unit, qty: '', rate: '' },
        other_charges: [],
        terms: p.terms.map((term) => ({ id: newId('t'), title: term.title, text: term.text })),
    };
}

// The supplied reference invoice, for "Load sample" and the tests.
function sampleInvoice(profile = DEFAULT_PROFILE) {
    const invoice = blankInvoice(profile, '2026-10-26');
    const group = 'PVC Pipes - uPVC Column Pipes';
    const item = (size, specification, pressure, coupler, qty, rate) => ({ id: newId('i'), description: group, size, specification, pressure, coupler, length: 3, hsn: '39172390', qty, rate });
    return {
        ...invoice,
        invoice: { ...invoice.invoice, number: 'Alfatth_26-27/PI-03R5', date: '2026-10-26' },
        consignee: {
            name: 'PMtech Water Solutions',
            address: 'K28, Plot 39-Abu Rawash Industrial Zone, Giza, Egypt',
            country: 'Egypt',
            tax_id: '757121691',
            acid: 'To be provided by Buyer prior to the shipment.',
            email: 'Abdelhamed@pmtech-egypt.com',
            phone: '+20 10 0439 6443',
        },
        buyer: {
            same_as_consignee: false,
            name: 'ALFATTH Import and Export FZ-LLC',
            address: 'A2-1505A, Building no. A2, Al Hamra Industrial Zone-FZ\nRas Al Khaimah',
            country: 'UAE',
            tax_id: '104817492200001',
            email: 'Abdelhamed@alfatth-uae.com',
            contact_person: '',
            phone: '+971 54 733 1749',
        },
        shipping: {
            ...invoice.shipping,
            place_of_delivery: 'Giza, Egypt',
            port_of_discharge: 'Alexandria Port, Egypt',
            destination_country: 'EGYPT',
            incoterm: 'CFR',
            incoterm_place: 'Alexandria Port, Egypt',
        },
        payment: { ...invoice.payment, advance: 10000 },
        items: [
            item('3"', 'Super Deluxe / Standard', '17 kgf/cm²', 'Standard Coupler', 1720, 10),
            item('4"', 'Super Deluxe / Standard', '17 kgf/cm²', 'Standard Coupler', 2020, 14.25),
            item('4"', 'Heavy', '27 kgf/cm²', 'Long Coupler', 500, 22.45),
            item('5"', 'Super Deluxe / Standard', '17 kgf/cm²', 'Standard Coupler', 1050, 21.4),
            item('5"', 'Heavy', '27 kgf/cm²', 'Long Coupler', 250, 38),
            item('5"', 'Super Heavy', '35 kgf/cm²', 'Long Coupler', 108, 45.75),
        ],
        inland_freight: { ...invoice.inland_freight, qty: 3, rate: 1100 },
        ocean_freight: { ...invoice.ocean_freight, description: 'Ocean Freight (Chennai Port, India to Alexandria Port, Egypt) #', qty: 3, rate: 6400 },
    };
}

// Saved profiles may predate a field: fill gaps from the factory default.
function mergeProfile(profile = {}) {
    const base = clone(DEFAULT_PROFILE);
    const source = profile && typeof profile === 'object' ? profile : {};
    const merged = { ...base };
    for (const key of Object.keys(base)) {
        const value = source[key];
        if (value === undefined || value === null) continue;
        if (Array.isArray(base[key])) merged[key] = Array.isArray(value) && value.length ? clone(value) : base[key];
        else if (typeof base[key] === 'object') merged[key] = { ...base[key], ...(typeof value === 'object' ? value : {}) };
        else merged[key] = typeof value === typeof base[key] ? value : base[key];
    }
    return merged;
}

module.exports = {
    CURRENCIES,
    INCOTERMS,
    DEFAULT_TERMS,
    DEFAULT_PROFILE,
    newId,
    blankItem,
    blankInvoice,
    sampleInvoice,
    mergeProfile,
};
