const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const Anthropic = require("@anthropic-ai/sdk");

const KEY = defineSecret("ANTHROPIC_API_KEY");
const ALLOWED_EMAIL = "SENIN_MAILIN@gmail.com"; // TODO: kendi Google mailin
const MODEL = "claude-sonnet-5-5";

// Konu listesi: trend analizi için sabit kalmalı. Eksikleri sen tamamla.
const KONULAR = {
  Anatomi: ["Üst ekstremite", "Alt ekstremite", "Toraks", "Abdomen-pelvis", "Baş-boyun", "Nöroanatomi", "Embriyoloji", "Histoloji"],
  Fizyoloji: ["Kas", "Sinir", "Kardiyovasküler", "Solunum", "Böbrek-asit baz", "GİS", "Endokrin", "Nörofizyoloji"],
  Biyokimya: ["Karbonhidrat", "Lipid", "Aminoasit-protein", "Nükleotid", "Vitamin-mineral", "Enzimler", "Moleküler biyoloji", "Hormon-sinyal"],
  Mikrobiyoloji: ["Bakteriyoloji", "Viroloji", "Mikoloji", "Parazitoloji", "İmmünoloji", "Sterilizasyon-genel"],
  Patoloji: ["Genel patoloji", "Kardiyovasküler", "Solunum", "GİS", "Böbrek-ürogenital", "Endokrin", "Kemik-yumuşak doku", "SSS", "Hematopatoloji", "Meme-jinekopatoloji"],
  Farmakoloji: ["Genel farmakoloji", "ANS", "Kardiyovasküler", "SSS", "Antibiyotikler", "Kemoterapötikler", "Endokrin", "Toksikoloji"],
  Dahiliye: ["Kardiyoloji", "Pulmoner", "Gastroenteroloji", "Nefroloji", "Endokrinoloji", "Hematoloji", "Romatoloji", "Enfeksiyon", "Onkoloji", "Nöroloji", "Acil-toksikoloji"],
  Pediatri: ["Yenidoğan", "Büyüme-gelişme", "Metabolik hastalıklar", "Hematoloji-onkoloji", "Nefroloji", "Enfeksiyon", "Genetik", "Kardiyoloji", "Endokrin", "Gastroenteroloji", "Aşılama-beslenme"],
  "Genel Cerrahi": ["Şok-sıvı-elektrolit", "Yara-enfeksiyon", "Özofagus-mide", "Ince-kalın barsak", "Karaciğer-safra-pankreas", "Meme", "Endokrin cerrahi", "Travma", "Herni-anorektal", "Anestezi"],
  "Kadın Doğum": ["Gebelik-doğum", "Jinekolojik onkoloji", "Anormal uterin kanama", "Kontrasepsiyon", "Infertilite-endokrin", "Enfeksiyon"],
  "Küçük Stajlar": ["Göz", "KBB", "Ortopedi", "Üroloji", "Nöroşirürji", "Plastik-yanık", "Psikiyatri", "Dermatoloji", "Radyoloji", "Halk sağlığı-adli tıp"],
};

// İşaretleme düzenin: değiştirirsen sadece bu metni düzenle.
const ISARET_KURALI = `
Kullanıcının işaretleme düzeni:
- Soru numarası yanında/üstünde mavi X veya + varsa ve yanına el yazısıyla harf YAZILMAMIŞSA: doğru ("D").
- Soruya veya yanına el yazısıyla bir harf yazılmışsa: yanlış ("Y"). Yazılan harf doğru cevaptır.
- Hiç işaret yoksa: boş ("B").
- Şıklar üstü çizili/daireli olabilir; bu tek başına karar vermek için yetmez.
Yukarıdaki kurallara net uymayan, çelişkili veya okunamayan HER durumda c = "suphe" yaz. Emin değilsen "suphe" de, tahmin etme.`;

const PROMPT_READ = `Bu fotoğraflar bir TUS deneme sınavının sayfaları. Görünen HER soru için sonucu çıkar.
${ISARET_KURALI}
Sadece JSON döndür, başka metin yazma:
{"items":[{"no":173,"r":"D|Y|B","c":"kesin|suphe","note":"sadece suphe ise kısa neden (Türkçe)"}]}
Soru numarasını sayfada yazdığı gibi oku. Görünmeyen veya kesik soruyu da listele: r:"B", c:"suphe", note:"okunamadı".`;

function promptTag(wrong) {
  return `Bu fotoğraflar bir TUS deneme sınavının sayfaları. Şu soru numaraları yanlış yapıldı: ${wrong.join(", ")}.
Her biri için soru metnini oku ve ders ile konuyu belirle. Ders ve konu SADECE şu listeden seçilmeli:
${JSON.stringify(KONULAR)}
Liste dışı kalıyorsa konu alanına "Diğer: <kısa ad>" yaz. Soru okunamıyorsa konu "okunamadı" olsun.
Sadece JSON döndür:
{"items":[{"no":176,"ders":"Genel Cerrahi","konu":"Herni-anorektal","c":"kesin|suphe"}]}`;
}

exports.analyzeExam = onCall(
  { region: "europe-west1", secrets: [KEY], timeoutSeconds: 300, memory: "512MiB" },
  async (req) => {
    if (!req.auth || req.auth.token.email !== ALLOWED_EMAIL) {
      throw new HttpsError("permission-denied", "Yetkisiz");
    }
    const { mode, images, wrong } = req.data || {};
    if (!Array.isArray(images) || images.length < 1 || images.length > 14) {
      throw new HttpsError("invalid-argument", "1-14 görsel gönder");
    }
    if (mode === "tag" && (!Array.isArray(wrong) || wrong.length === 0)) {
      throw new HttpsError("invalid-argument", "Yanlış listesi boş");
    }

    const client = new Anthropic({ apiKey: KEY.value() });
    const content = images.map((d) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: d },
    }));
    content.push({ type: "text", text: mode === "tag" ? promptTag(wrong) : PROMPT_READ });

    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: "user", content }],
    });
    const txt = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    try {
      return JSON.parse(txt.replace(/```json|```/g, "").trim());
    } catch (e) {
      throw new HttpsError("internal", "Model çıktısı JSON değil, tekrar dene");
    }
  }
);
