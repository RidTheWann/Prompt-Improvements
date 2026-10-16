export const PROMPT_TEMPLATES = [
  {
    id: "email",
    label: "Tulis email",
    icon: "✉️",
    prompt: "Tulis email profesional yang sopan dan jelas.",
    objective: "Email siap kirim yang mudah dipahami penerima.",
    context: "Penerima: [siapa]. Situasi: [apa yang terjadi].",
    constraints: "Maksimal 150 kata\nNada sopan dan ramah",
    outputFormat: "prose"
  },
  {
    id: "summary",
    label: "Ringkas teks",
    icon: "📝",
    prompt: "Ringkas teks berikut menjadi poin-poin utama.\n\nTeks:\n[tempel teks di sini]",
    objective: "Ringkasan yang akurat tanpa menambah informasi baru.",
    constraints: "Maksimal 5 poin\nJangan menambahkan informasi yang tidak ada di teks",
    outputFormat: "checklist"
  },
  {
    id: "learn",
    label: "Belajar topik",
    icon: "🎓",
    prompt: "Jelaskan [topik] dengan bahasa sederhana beserta contoh.",
    audience: "Pemula tanpa latar belakang teknis",
    constraints: "Hindari istilah rumit tanpa penjelasan\nSertakan satu contoh sehari-hari",
    outputFormat: "markdown"
  },
  {
    id: "code",
    label: "Bantu coding",
    icon: "💻",
    prompt: "Buatkan [fitur] menggunakan [bahasa pemrograman].",
    context: "Proyek saat ini: [ceritakan singkat].",
    constraints: "Sertakan cara menjalankan\nJelaskan asumsi yang dipakai",
    outputFormat: "code"
  },
  {
    id: "ideas",
    label: "Cari ide",
    icon: "💡",
    prompt: "Berikan 10 ide untuk [tujuan].",
    constraints: "Ide harus realistis dan bisa dimulai dengan modal kecil",
    outputFormat: "table"
  }
];

export function getTemplate(id) {
  return PROMPT_TEMPLATES.find((item) => item.id === id) ?? null;
}
