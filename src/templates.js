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
  },
  {
    id: "plan",
    label: "Buat rencana",
    icon: "🗓️",
    prompt: "Buat rencana langkah demi langkah untuk [tujuan] dengan target waktu [jangka waktu].",
    audience: "Pemula yang butuh arahan praktis",
    constraints: "Urutkan langkah menurut prioritas\nJangan mengasumsikan sumber daya yang belum disebutkan",
    outputFormat: "checklist"
  },
  {
    id: "research",
    label: "Riset topik",
    icon: "🔎",
    prompt: "Riset [topik] berdasarkan sumber tepercaya dan jelaskan temuan utamanya.",
    objective: "Ringkasan bukti yang dapat diverifikasi dan mudah dipahami.",
    constraints: "Cantumkan sumber dan tanggal bila tersedia\nPisahkan fakta, inferensi, dan hal yang belum pasti",
    outputFormat: "markdown"
  },
  {
    id: "compare",
    label: "Bandingkan opsi",
    icon: "⚖️",
    prompt: "Bandingkan [opsi A] dan [opsi B] berdasarkan kebutuhan dan kriteria yang relevan.",
    objective: "Rekomendasi dengan alasan dan trade-off yang jelas.",
    constraints: "Jangan mengarang data harga atau spesifikasi\nNyatakan informasi yang belum tersedia",
    outputFormat: "table"
  }
];

export function getTemplate(id) {
  return PROMPT_TEMPLATES.find((item) => item.id === id) ?? null;
}
