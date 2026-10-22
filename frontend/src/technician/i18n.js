// English / Tamil text for the public technician partner registration page.
// One dictionary per language with the same keys; option VALUES (districts,
// states) stay English — only their displayed names are translated.

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ta', label: 'தமிழ்' },
]

const en = {
  pageTitle: 'Mechanic / Technician Partner Registration | Sudarshan Pipes',
  headerTitle: 'Partner Registration',
  language: 'Language',
  companyName: 'Sudarshan Extrusions Pvt. Ltd.',
  tagline: 'Pipes & Fittings',
  heading: 'Our Mechanic/Technician Partner\'s Registration Form',
  subheading: 'Join the Sudarshan Pipes Partner Network and grow together with us.',
  requiredNote: 'Fields marked * are required.',
  optional: '(optional)',

  full_name: 'Name',
  district: 'District',
  place: 'Place',
  mobile: 'Contact Number',
  address: 'Address',
  pincode: 'Pincode',
  state: 'State',
  date_of_birth: 'Date of Birth',
  date_of_marriage: 'Date of Marriage',
  aadhaar: 'Aadhaar Card',

  full_namePlaceholder: 'Your full name',
  placePlaceholder: 'Town, village or locality',
  mobilePlaceholder: '98765 43210',
  addressPlaceholder: 'House no., street, area, landmark',
  pincodePlaceholder: '6-digit PIN code',
  selectDistrict: 'Select District',
  selectState: 'Select State',
  countryCode: 'India country code +91',
  selectedDate: 'Selected: {date}',

  aadhaarHelp: 'PDF, JPG, JPEG or PNG, up to 5 MB. You can register without it.',
  aadhaarPrivacy: 'Your Aadhaar is stored privately and is seen only by authorised Sudarshan staff.',
  chooseFile: 'Choose file',
  replaceFile: 'Replace',
  removeFile: 'Remove',

  submit: 'Submit Registration',
  submitting: 'Submitting…',
  secureNote: 'Your details are sent securely and are seen only by the Sudarshan team.',
  fixErrors: 'Please fix {count} marked field(s) below, then submit again.',
  networkError: 'Could not reach the server. Check your internet connection and try again. Your entries are still here.',
  serverError: 'Your registration could not be submitted. Please try again in a few minutes. Your entries are still here.',
  rateLimited: 'Too many submissions from this network. Please try again in an hour. Your entries are still here.',

  successTitle: 'Thank you! Your registration has been submitted.',
  successRef: 'Your reference number is',
  successBody: 'Please keep this number for any follow-up. Our team will contact you on {mobile}.',
  registerAnother: 'Register another partner',
  footer: 'Partner registration',

  errors: {
    required: '{field} is required.',
    invalid_name: 'Enter your full name (at least 2 letters).',
    invalid_option: 'Choose an option from the list.',
    too_long: 'This is too long. Please shorten it.',
    invalid_mobile: 'Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9.',
    invalid_pincode: 'Enter a valid 6-digit PIN code.',
    invalid_date: 'Enter a valid date.',
    future_date: 'The date cannot be in the future.',
    marriage_before_birth: 'Date of marriage cannot be before the date of birth.',
    invalid_file: 'Upload a PDF, JPG, JPEG or PNG file.',
    file_too_large: 'The file must be 5 MB or smaller.',
    file_empty: 'This file is empty. Choose another file.',
    generic: 'Please check this field.',
  },
  districts: {},
  states: {},
}

const ta = {
  pageTitle: 'மெக்கானிக் / டெக்னீஷியன் கூட்டாளர் பதிவு | சுதர்சன் பைப்ஸ்',
  headerTitle: 'கூட்டாளர் பதிவு',
  language: 'மொழி',
  companyName: 'சுதர்சன் எக்ஸ்ட்ரூஷன்ஸ் பிரைவேட் லிமிடெட்',
  tagline: 'குழாய்கள் & பொருத்துதல்கள்',
  heading: 'எங்கள் மெக்கானிக்/டெக்னீஷியன் கூட்டாளர் பதிவுப் படிவம்',
  subheading: 'சுதர்சன் பைப்ஸ் கூட்டாளர் நெட்வொர்க்கில் இணைந்து எங்களுடன் சேர்ந்து வளருங்கள்.',
  requiredNote: '* குறியிட்ட புலங்கள் கட்டாயம்.',
  optional: '(விருப்பத்தேர்வு)',

  full_name: 'பெயர்',
  district: 'மாவட்டம்',
  place: 'ஊர் / இடம்',
  mobile: 'தொடர்பு எண்',
  address: 'முகவரி',
  pincode: 'அஞ்சல் குறியீடு',
  state: 'மாநிலம்',
  date_of_birth: 'பிறந்த தேதி',
  date_of_marriage: 'திருமண தேதி',
  aadhaar: 'ஆதார் அட்டை',

  full_namePlaceholder: 'உங்கள் முழுப் பெயர்',
  placePlaceholder: 'நகரம், கிராமம் அல்லது பகுதி',
  mobilePlaceholder: '98765 43210',
  addressPlaceholder: 'வீட்டு எண், தெரு, பகுதி, அடையாளம்',
  pincodePlaceholder: '6 இலக்க அஞ்சல் குறியீடு',
  selectDistrict: 'மாவட்டத்தைத் தேர்ந்தெடுக்கவும்',
  selectState: 'மாநிலத்தைத் தேர்ந்தெடுக்கவும்',
  countryCode: 'இந்திய நாட்டுக் குறியீடு +91',
  selectedDate: 'தேர்ந்தெடுத்தது: {date}',

  aadhaarHelp: 'PDF, JPG, JPEG அல்லது PNG, 5 MB வரை. இது இல்லாமலும் பதிவு செய்யலாம்.',
  aadhaarPrivacy: 'உங்கள் ஆதார் பாதுகாப்பாகச் சேமிக்கப்படும்; அங்கீகரிக்கப்பட்ட சுதர்சன் ஊழியர்கள் மட்டுமே பார்க்க முடியும்.',
  chooseFile: 'கோப்பைத் தேர்ந்தெடுக்கவும்',
  replaceFile: 'மாற்றவும்',
  removeFile: 'நீக்கவும்',

  submit: 'பதிவைச் சமர்ப்பிக்கவும்',
  submitting: 'சமர்ப்பிக்கப்படுகிறது…',
  secureNote: 'உங்கள் விவரங்கள் பாதுகாப்பாக அனுப்பப்படுகின்றன; சுதர்சன் குழு மட்டுமே பார்க்கும்.',
  fixErrors: 'கீழே குறிக்கப்பட்ட {count} புலங்களைச் சரிசெய்து மீண்டும் சமர்ப்பிக்கவும்.',
  networkError: 'சேவையகத்தை அணுக முடியவில்லை. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும். நீங்கள் உள்ளிட்ட விவரங்கள் அப்படியே உள்ளன.',
  serverError: 'உங்கள் பதிவைச் சமர்ப்பிக்க முடியவில்லை. சில நிமிடங்கள் கழித்து மீண்டும் முயற்சிக்கவும். நீங்கள் உள்ளிட்ட விவரங்கள் அப்படியே உள்ளன.',
  rateLimited: 'இந்த நெட்வொர்க்கிலிருந்து அதிகமான சமர்ப்பிப்புகள் வந்துள்ளன. ஒரு மணி நேரம் கழித்து மீண்டும் முயற்சிக்கவும். நீங்கள் உள்ளிட்ட விவரங்கள் அப்படியே உள்ளன.',

  successTitle: 'நன்றி! உங்கள் பதிவு சமர்ப்பிக்கப்பட்டது.',
  successRef: 'உங்கள் குறிப்பு எண்',
  successBody: 'தொடர்புக்கு இந்த எண்ணை வைத்துக்கொள்ளவும். எங்கள் குழு உங்களை {mobile} என்ற எண்ணில் தொடர்பு கொள்ளும்.',
  registerAnother: 'மற்றொரு கூட்டாளரைப் பதிவு செய்யவும்',
  footer: 'கூட்டாளர் பதிவு',

  errors: {
    required: '{field} அவசியம்.',
    invalid_name: 'உங்கள் முழுப் பெயரை உள்ளிடவும் (குறைந்தது 2 எழுத்துகள்).',
    invalid_option: 'பட்டியலில் இருந்து ஒன்றைத் தேர்ந்தெடுக்கவும்.',
    too_long: 'இது மிக நீளமாக உள்ளது. சுருக்கவும்.',
    invalid_mobile: '6, 7, 8 அல்லது 9 இல் தொடங்கும் சரியான 10 இலக்க இந்திய மொபைல் எண்ணை உள்ளிடவும்.',
    invalid_pincode: 'சரியான 6 இலக்க அஞ்சல் குறியீட்டை உள்ளிடவும்.',
    invalid_date: 'சரியான தேதியை உள்ளிடவும்.',
    future_date: 'எதிர்காலத் தேதியை உள்ளிட முடியாது.',
    marriage_before_birth: 'திருமண தேதி பிறந்த தேதிக்கு முன்பாக இருக்கக்கூடாது.',
    invalid_file: 'PDF, JPG, JPEG அல்லது PNG கோப்பைப் பதிவேற்றவும்.',
    file_too_large: 'கோப்பு 5 MB அல்லது அதற்குக் குறைவாக இருக்க வேண்டும்.',
    file_empty: 'இந்தக் கோப்பு காலியாக உள்ளது. வேறு கோப்பைத் தேர்ந்தெடுக்கவும்.',
    generic: 'இந்தப் புலத்தைச் சரிபார்க்கவும்.',
  },
  districts: {
    Ariyalur: 'அரியலூர்', Chengalpattu: 'செங்கல்பட்டு', Chennai: 'சென்னை', Coimbatore: 'கோயம்புத்தூர்',
    Cuddalore: 'கடலூர்', Dharmapuri: 'தருமபுரி', Dindigul: 'திண்டுக்கல்', Erode: 'ஈரோடு',
    Kallakurichi: 'கள்ளக்குறிச்சி', Kancheepuram: 'காஞ்சிபுரம்', Kanniyakumari: 'கன்னியாகுமரி', Karur: 'கரூர்',
    Krishnagiri: 'கிருஷ்ணகிரி', Madurai: 'மதுரை', Mayiladuthurai: 'மயிலாடுதுறை', Nagapattinam: 'நாகப்பட்டினம்',
    Namakkal: 'நாமக்கல்', Nilgiris: 'நீலகிரி', Perambalur: 'பெரம்பலூர்', Pudukkottai: 'புதுக்கோட்டை',
    Ramanathapuram: 'இராமநாதபுரம்', Ranipet: 'இராணிப்பேட்டை', Salem: 'சேலம்', Sivaganga: 'சிவகங்கை',
    Tenkasi: 'தென்காசி', Thanjavur: 'தஞ்சாவூர்', Theni: 'தேனி', Thoothukudi: 'தூத்துக்குடி',
    Tiruchirappalli: 'திருச்சிராப்பள்ளி', Tirunelveli: 'திருநெல்வேலி', Tirupathur: 'திருப்பத்தூர்', Tiruppur: 'திருப்பூர்',
    Tiruvallur: 'திருவள்ளூர்', Tiruvannamalai: 'திருவண்ணாமலை', Tiruvarur: 'திருவாரூர்', Vellore: 'வேலூர்',
    Viluppuram: 'விழுப்புரம்', Virudhunagar: 'விருதுநகர்',
  },
  states: {
    'Tamil Nadu': 'தமிழ்நாடு',
    Karnataka: 'கர்நாடகா',
    'Andhra Pradesh': 'ஆந்திரப் பிரதேசம்',
  },
}

export const TRANSLATIONS = { en, ta }

/** Translator for one language: t('key', { vars }), t.error(code, field), t.district(name), t.state(name). */
export function translator(lang) {
  const dict = TRANSLATIONS[lang] || en
  const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? ''))
  const t = (key, vars) => fill(dict[key] ?? en[key] ?? key, vars)
  t.error = (code, field) => fill(dict.errors[code] || dict.errors.generic, { field: dict[field] || field })
  t.district = (name) => dict.districts[name] || name
  t.state = (name) => dict.states[name] || name
  return t
}
