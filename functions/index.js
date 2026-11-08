const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const Anthropic = require('@anthropic-ai/sdk');

initializeApp();
const adminDb = getFirestore();
const KEY = defineSecret('ANTHROPIC_API_KEY');
const MODEL = 'claude-sonnet-5-5'; // Mevcut sunucu dosyasındaki model ayarı korundu.
const MAX_CALLS_PER_DAY = 30;
const MAX_IMAGE_CHARS = 11_000_000;

const KONULAR = {
  Anatomi: ['Üst ekstremite','Alt ekstremite','Toraks','Abdomen-pelvis','Baş-boyun','Nöroanatomi','Embriyoloji','Histoloji'],
  Fizyoloji: ['Kas','Sinir','Kardiyovasküler','Solunum','Böbrek-asit baz','GİS','Endokrin','Nörofizyoloji'],
  Biyokimya: ['Karbonhidrat','Lipid','Aminoasit-protein','Nükleotid','Vitamin-mineral','Enzimler','Moleküler biyoloji','Hormon-sinyal'],
  Mikrobiyoloji: ['Bakteriyoloji','Viroloji','Mikoloji','Parazitoloji','İmmünoloji','Sterilizasyon-genel'],
  Patoloji: ['Genel patoloji','Kardiyovasküler','Solunum','GİS','Böbrek-ürogenital','Endokrin','Kemik-yumuşak doku','SSS','Hematopatoloji','Meme-jinekopatoloji'],
  Farmakoloji: ['Genel farmakoloji','ANS','Kardiyovasküler','SSS','Antibiyotikler','Kemoterapötikler','Endokrin','Toksikoloji'],
  Dahiliye: ['Kardiyoloji','Pulmoner','Gastroenteroloji','Nefroloji','Endokrinoloji','Hematoloji','Romatoloji','Enfeksiyon','Onkoloji','Nöroloji','Acil-toksikoloji'],
  Pediatri: ['Yenidoğan','Büyüme-gelişme','Metabolik hastalıklar','Hematoloji-onkoloji','Nefroloji','Enfeksiyon','Genetik','Kardiyoloji','Endokrin','Gastroenteroloji','Aşılama-beslenme'],
  'Genel Cerrahi': ['Şok-sıvı-elektrolit','Yara-enfeksiyon','Özofagus-mide','Ince-kalın barsak','Karaciğer-safra-pankreas','Meme','Endokrin cerrahi','Travma','Herni-anorektal','Anestezi'],
  'Kadın Doğum': ['Gebelik-doğum','Jinekolojik onkoloji','Anormal uterin kanama','Kontrasepsiyon','Infertilite-endokrin','Enfeksiyon'],
  'Küçük Stajlar': ['Göz','KBB','Ortopedi','Üroloji','Nöroşirürji','Plastik-yanık','Psikiyatri','Dermatoloji','Radyoloji','Halk sağlığı-adli tıp'],
};

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
  return `Bu fotoğraflar bir TUS deneme sınavının sayfaları. Şu soru numaraları yanlış yapıldı: ${wrong.join(', ')}.
Her biri için soru metnini oku ve ders ile konuyu belirle. Ders ve konu SADECE şu listeden seçilmeli:
${JSON.stringify(KONULAR)}
Liste dışı kalıyorsa konu alanına "Diğer: <kısa ad>" yaz. Soru okunamıyorsa konu "okunamadı" olsun.
Sadece JSON döndür:
{"items":[{"no":176,"ders":"Genel Cerrahi","konu":"Herni-anorektal","c":"kesin|suphe"}]}`;
}

async function enforceDailyLimit(uid) {
  const ref = adminDb.collection('_privateAnalyzeUsage').doc(uid);
  const now = Date.now();
  await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const old = snap.exists ? snap.data() : {};
    let start = Number(old.windowStartMs || now);
    let count = Number(old.count || 0);
    if (now - start >= 24 * 60 * 60 * 1000 || now < start) { start = now; count = 0; }
    if (count >= MAX_CALLS_PER_DAY) {
      throw new HttpsError('resource-exhausted', 'Günlük fotoğraf analiz sınırına ulaşıldı. 24 saat sonra tekrar deneyebilirsin.');
    }
    tx.set(ref, { windowStartMs: start, count: count + 1, updatedAt: FieldValue.serverTimestamp() });
  });
}

exports.analyzeExam = onCall(
  { region: 'europe-west1', secrets: [KEY], timeoutSeconds: 300, memory: '512MiB', maxInstances: 3 },
  async req => {
    // İstemci Google hesabı istemez; tarayıcı arka planda anonim Firebase oturumu açar.
    const provider = req.auth?.token?.firebase?.sign_in_provider;
    if (!req.auth || provider !== 'anonymous') {
      throw new HttpsError('unauthenticated', 'Fotoğraf analizi için anonim oturum açılamadı.');
    }

    const { mode, images, wrong } = req.data || {};
    if (!['read', 'tag'].includes(mode)) throw new HttpsError('invalid-argument', 'Geçersiz analiz modu.');
    if (!Array.isArray(images) || images.length < 1 || images.length > 14 || images.some(x => typeof x !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(x))) {
      throw new HttpsError('invalid-argument', '1-14 adet geçerli JPEG görsel gönder.');
    }
    const totalChars = images.reduce((sum, image) => sum + image.length, 0);
    if (totalChars > MAX_IMAGE_CHARS) throw new HttpsError('invalid-argument', 'Görsellerin toplam boyutu çok büyük.');
    if (mode === 'tag' && (!Array.isArray(wrong) || wrong.length < 1 || wrong.length > 200 || wrong.some(n => !Number.isInteger(n) || n < 1 || n > 200))) {
      throw new HttpsError('invalid-argument', 'Yanlış soru listesi geçersiz.');
    }

    await enforceDailyLimit(req.auth.uid);

    try {
      const client = new Anthropic({ apiKey: KEY.value() });
      const content = images.map(data => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data },
      }));
      content.push({ type: 'text', text: mode === 'tag' ? promptTag(wrong) : PROMPT_READ });

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        messages: [{ role: 'user', content }],
      });
      const raw = response.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      let parsed;
      try { parsed = JSON.parse(cleaned); }
      catch {
        const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('JSON bulunamadı');
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      }
      if (!parsed || !Array.isArray(parsed.items)) throw new Error('items listesi bulunamadı');
      return parsed;
    } catch (error) {
      console.error('analyzeExam error:', error);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', 'Fotoğraf analizi başarısız oldu. Biraz sonra tekrar dene.');
    }
  }
);
