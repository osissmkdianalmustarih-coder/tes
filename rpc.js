const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const ROLE_OPERASIONAL_PENUH = ['Developer', 'Super Admin', 'Pengawas', 'Ketua OSIS', 'Wakil OSIS', 'Wakil Ketua OSIS'];
const ROLE_SEMUA_ADMIN = ['Developer', 'Super Admin', 'Pengawas', 'Ketua OSIS', 'Wakil OSIS', 'Wakil Ketua OSIS'];

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function verifySecret(inputPlain, storedValue) {
  const cleanInput = String(inputPlain ?? '').trim();
  const cleanStored = String(storedValue ?? '').trim();
  if (!cleanInput || !cleanStored) return false;
  return cleanInput === cleanStored || sha256(cleanInput).toLowerCase() === cleanStored.toLowerCase();
}

function getJakartaDateParts(dateObj = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = {};
  formatter.formatToParts(dateObj).forEach(p => { parts[p.type] = p.value; });
  return {
    tglStr: `${parts.year}-${parts.month}-${parts.day}`,
    jamStr: `${parts.hour}:${parts.minute}`
  };
}

function getNamaHariJakarta(tanggalStr) {
  const namaHari = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const p = String(tanggalStr || '').split('-').map(Number);
  if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return '';
  return namaHari[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
}

function jadwalCocokHariAtauTanggal(nilai, tanggalStr) {
  if (!nilai) return false;
  const raw = String(nilai).trim();
  if (raw === tanggalStr) return true;
  const hariIni = getNamaHariJakarta(tanggalStr).toLowerCase();
  return raw.split(/[,;|]/).map(x => x.trim().toLowerCase()).includes(hariIni);
}

function normalizeFonnteTarget(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) throw new Error('Nomor WhatsApp orang tua belum diisi.');
  if (digits.startsWith('0')) digits = '62' + digits.substring(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  if (!digits.startsWith('62') || digits.length < 10 || digits.length > 15) {
    throw new Error('Format nomor WhatsApp tidak valid.');
  }
  return digits;
}

async function sendFonnteMessage(target, message) {
  const token = process.env.FONNTE_TOKEN;
  if (!token) return { success: false, reason: 'FONNTE_TOKEN belum diatur di Environment Variables Vercel.' };
  let formattedTarget;
  try {
    formattedTarget = normalizeFonnteTarget(target);
  } catch (e) {
    return { success: false, reason: e.message };
  }

  try {
    const body = new URLSearchParams();
    body.append('target', formattedTarget);
    body.append('message', String(message || ''));
    const resp = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: token },
      body
    });
    const json = await resp.json();
    const ok = json.status === true || String(json.status) === 'true';
    return { success: ok, reason: json.reason || json.message || '' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function getSettingValue(key, defaultValue) {
  const { data } = await supabase.from('pengaturan').select('value').eq('key', key).maybeSingle();
  return data && data.value !== undefined && data.value !== null && data.value !== '' ? String(data.value).trim() : defaultValue;
}

async function isAttendanceOpen() {
  const val = await getSettingValue('ATTENDANCE_ENABLED', 'true');
  return String(val).toLowerCase() !== 'false';
}

async function loginAdminServer(username, password) {
  if (!username || !password) return { success: false, message: 'Username dan password wajib diisi!' };
  const cleanUser = String(username).trim();
  const { data: user, error } = await supabase.from('admin').select('*').eq('username', cleanUser).maybeSingle();
  if (error || !user) return { success: false, message: 'Username atau Password salah!' };
  if (!verifySecret(password, user.password_hash)) return { success: false, message: 'Username atau Password salah!' };
  if (String(user.status || 'Aktif').toLowerCase() !== 'aktif') {
    return { success: false, message: 'Akun Administrator ini dinonaktifkan!' };
  }
  return { success: true, username: user.username, role: user.role };
}

async function verifyAdminAuth(auth, allowedRoles) {
  if (!auth || !auth.username || !auth.password || String(auth.role || '').trim() === 'Anggota OSIS') return false;
  const res = await loginAdminServer(auth.username, auth.password);
  if (!res.success || res.role !== String(auth.role || '').trim()) return false;
  if (!allowedRoles) return true;
  return allowedRoles.includes(res.role);
}

async function verifyAnggotaReadOnlyAuth(auth) {
  if (!auth || !auth.username || !auth.password || String(auth.role || '').trim() !== 'Anggota OSIS') return false;
  const res = await loginAdminServer(auth.username, auth.password);
  return !!(res.success && res.role === 'Anggota OSIS');
}

async function uploadBase64ToStorage(bucket, fileName, base64Data) {
  const splitData = String(base64Data || '').split(',');
  if (splitData.length < 2) throw new Error('Format Base64 tidak valid.');
  const mimeMatch = splitData[0].match(/:(.*?);/);
  const contentType = mimeMatch ? mimeMatch[1] : 'image/png';
  const buffer = Buffer.from(splitData[1], 'base64');

  const { error } = await supabase.storage.from(bucket).upload(fileName, buffer, {
    contentType,
    upsert: true
  });
  if (error) throw new Error('Gagal upload ke Supabase Storage: ' + error.message);

  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return pub.publicUrl;
}

async function generateAndUploadQrCode(qrToken, namaSiswa, kelasSiswa, baseUrl) {
  try {
    const qrContent = baseUrl ? `${baseUrl}?scan_id=${encodeURIComponent(qrToken)}` : qrToken;
    const qrApiUrl = `https://quickchart.io/qr?text=${encodeURIComponent(qrContent)}&size=1000&margin=2&ecLevel=M&format=png`;
    const resp = await fetch(qrApiUrl);
    if (!resp.ok) return '';
    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const cleanNama = String(namaSiswa || '').replace(/[^a-zA-Z0-9]/g, '_');
    const cleanKelas = String(kelasSiswa || '').replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `QR_${cleanKelas}_${cleanNama}_${qrToken}.png`;

    const { error } = await supabase.storage.from('kartu-qr').upload(fileName, buffer, {
      contentType: 'image/png',
      upsert: true
    });
    if (error) return '';
    const { data: pub } = supabase.storage.from('kartu-qr').getPublicUrl(fileName);
    return pub.publicUrl;
  } catch (e) {
    return '';
  }
}

async function isPetugasBertugasHariIni(namaAtauId, tanggalStr) {
  const { data: rows } = await supabase.from('jadwal_petugas').select('*');
  if (!rows || rows.length === 0) return false;
  const target = String(namaAtauId || '').trim().toLowerCase();
  if (!target) return false;
  return rows.some(r =>
    jadwalCocokHariAtauTanggal(r.hari, tanggalStr) &&
    String(r.status || 'Aktif').trim().toLowerCase() === 'aktif' &&
    (target === String(r.id_atau_username || '').trim().toLowerCase() ||
     target === String(r.nama_petugas || '').trim().toLowerCase())
  );
}

async function logAudit(aksi, idAbsensi, pelaku, detail) {
  await supabase.from('audit_absensi').insert([{
    aksi: String(aksi || ''),
    id_absensi: String(idAbsensi || ''),
    pelaku: String(pelaku || ''),
    detail: String(detail || '')
  }]);
}

function nextFormattedId(rows, colName, prefix, padLen) {
  let maxNum = 0;
  (rows || []).forEach(r => {
    const num = parseInt(String(r[colName] || '').replace(/\D/g, ''), 10);
    if (!isNaN(num) && num > maxNum) maxNum = num;
  });
  return prefix + String(maxNum + 1).padStart(padLen, '0');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const { action, args = [] } = req.body || {};
  const originUrl = req.headers.origin || '';

  try {
    switch (action) {
      case 'getUniformLabels': {
        const val = await getSettingValue('UNIFORM_LABELS_JSON', '');
        if (!val) {
          return res.json({
            success: true,
            labels: { badgeSekolah: 'Badge Sekolah', badgeOsis: 'Badge OSIS', dasi: 'Dasi', ikatPinggang: 'Ikat Pinggang', kaosKaki: 'Kaos Kaki', sepatu: 'Sepatu', atributLainnya: 'Atribut Lain', catatan: 'Catatan Seragam' },
            customAttributes: []
          });
        }
        const parsed = JSON.parse(val);
        return res.json({ success: true, labels: parsed.labels || parsed, customAttributes: parsed.customAttributes || [] });
      }

      case 'saveUniformLabels': {
        const [auth, labelsObj] = args;
        if (!(await verifyAdminAuth(auth, ROLE_OPERASIONAL_PENUH))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }
        await supabase.from('pengaturan').upsert({
          key: 'UNIFORM_LABELS_JSON',
          value: JSON.stringify(labelsObj || {}),
          keterangan: 'Konfigurasi nama atribut seragam kustom'
        });
        return res.json({ success: true, labels: (labelsObj && labelsObj.labels) || labelsObj, customAttributes: [] });
      }

      case 'getRealtimeAttendanceStatus': {
        const { tglStr } = getJakartaDateParts();
        const enabled = await isAttendanceOpen();
        const { data: rows } = await supabase.from('absensi').select('*').eq('tanggal', tglStr).order('created_at', { ascending: false });
        const attendedIdsToday = (rows || []).map(r => r.id_siswa).filter(id => id && id !== '-');
        const recentToday = (rows || []).map(r => ({
          idAbsensi: r.id,
          idSiswa: r.id_siswa,
          nama: r.nama_siswa,
          kelas: r.kelas,
          jam: r.jam_datang,
          idPetugas: r.id_petugas,
          namaPetugas: r.nama_petugas,
          metode: r.foto_url ? 'Manual' : 'QR / Manual'
        }));
        return res.json({ success: true, attendanceEnabled: enabled, attendedIdsToday, recentToday });
      }

      case 'verifikasiPetugas': {
        const [kodePetugas] = args;
        if (!kodePetugas) return res.json({ success: false, message: 'Kode verifikasi tidak boleh kosong!' });
        if (!(await isAttendanceOpen())) {
          return res.json({ success: false, attendanceClosed: true, message: 'Pengisian absensi sedang DITUTUP oleh Pengawas/Admin!' });
        }
        const { data: petugasList } = await supabase.from('petugas_osis').select('*');
        const cleanKode = String(kodePetugas).trim();
        const matched = (petugasList || []).find(p => verifySecret(cleanKode, p.kode));
        if (!matched) return res.json({ success: false, message: 'Kode verifikasi petugas OSIS tidak valid!' });
        if (String(matched.status || 'Aktif').toLowerCase() !== 'aktif') {
          return res.json({ success: false, message: 'Akun petugas OSIS ini berstatus Tidak Aktif!' });
        }

        const { data: kelasRows } = await supabase.from('kelas').select('nama_kelas, status');
        let listKelas = (kelasRows || []).filter(k => String(k.status).toLowerCase() === 'aktif').map(k => k.nama_kelas);
        if (listKelas.length === 0) listKelas = ['X KK', 'X BDP', 'XI KK', 'XI BDP', 'XII KK', 'XII BDP'];

        const { data: siswaRows } = await supabase.from('siswa').select('*').order('nama', { ascending: true });
        const listSiswa = (siswaRows || [])
          .filter(s => String(s.status || 'Aktif').toLowerCase() === 'aktif')
          .map(s => ({ id: s.id, nama: s.nama, kelas: s.kelas, qrToken: s.id }));

        const { tglStr } = getJakartaDateParts();
        const { data: absenToday } = await supabase.from('absensi').select('id_siswa').eq('tanggal', tglStr);
        const attendedIdsToday = (absenToday || []).map(a => a.id_siswa).filter(Boolean);
        const namaSekolah = await getSettingValue('NAMA_SEKOLAH', 'SMK DIAN AL MUSTARIH');

        return res.json({
          success: true,
          attendanceEnabled: true,
          petugas: { id: matched.id, nama: matched.nama, attendanceToken: sha256(matched.id + ':' + matched.kode) },
          namaSekolah,
          webAppUrl: originUrl,
          listKelas,
          listSiswa,
          attendedIdsToday
        });
      }

      case 'submitAbsensi': {
        const [payload] = args;
        if (!payload) return res.json({ success: false, message: 'Data absensi tidak ditemukan.' });
        if (!(await isAttendanceOpen())) {
          return res.json({ success: false, attendanceClosed: true, message: 'Pengisian absensi sedang DITUTUP oleh Admin/Pengawas!' });
        }

        const { data: petugasRow } = await supabase.from('petugas_osis').select('*').eq('id', payload.idPetugas).maybeSingle();
        if (!petugasRow || sha256(petugasRow.id + ':' + petugasRow.kode) !== payload.attendanceToken) {
          return res.json({ success: false, message: 'Sesi petugas tidak valid. Silakan login petugas kembali.' });
        }

        const { tglStr, jamStr } = getJakartaDateParts();
        const bertugas = await isPetugasBertugasHariIni(payload.idPetugas, tglStr) || await isPetugasBertugasHariIni(payload.namaPetugas, tglStr);

        if (!bertugas && !payload.approvalApproved) {
          if (!String(payload.alasanPermintaan || '').trim()) {
            return res.json({ success: false, needApprovalReason: true, message: 'Anda tidak terjadwal bertugas hari ini. Masukkan alasan untuk mengajukan persetujuan.' });
          }
          const { data: allReqs } = await supabase.from('persetujuan_absensi').select('id_request');
          const reqId = nextFormattedId(allReqs, 'id_request', 'REQ-', 4);
          await supabase.from('persetujuan_absensi').insert([{
            id_request: reqId,
            waktu_request: `${tglStr} ${jamStr}`,
            pemohon: payload.namaPetugas || 'Anggota OSIS',
            role: 'Petugas OSIS',
            nama_siswa: payload.namaSiswa,
            kelas: payload.kelas,
            data_absensi_json: payload,
            status: 'Menunggu',
            diproses_oleh: '-',
            alasan: String(payload.alasanPermintaan).trim()
          }]);
          return res.json({
            success: false,
            needApproval: true,
            requestId: reqId,
            message: `Permintaan absensi (${reqId}) telah dikirim dan menunggu persetujuan Admin.`
          });
        }

        const { data: existingAbsen } = await supabase
          .from('absensi')
          .select('id')
          .eq('tanggal', tglStr)
          .eq('id_siswa', payload.idSiswa)
          .maybeSingle();

        if (existingAbsen) {
          return res.json({ success: false, message: `Siswa "${payload.namaSiswa}" (${payload.kelas}) sudah diabsen hari ini!` });
        }

        let fotoUrl = '';
        if (payload.fotoBase64) {
          const namaFile = `Absen_${String(payload.kelas).replace(/\s+/g, '')}_${String(payload.namaSiswa).replace(/\s+/g, '_')}_${tglStr}_${Date.now()}.${payload.fotoExt || 'jpg'}`;
          fotoUrl = await uploadBase64ToStorage('bukti-absensi', namaFile, payload.fotoBase64);
        }

        const { data: allAbsen } = await supabase.from('absensi').select('id');
        const newId = nextFormattedId(allAbsen, 'id', 'ABS-', 4);

        const attrValues = [
          payload.badgeSekolah, payload.badgeOsis, payload.dasi,
          payload.ikatPinggang, payload.kaosKaki, payload.sepatu, payload.atributLainnya
        ];
        const statusSeragamGlobal = attrValues.every(val => val === 'Lengkap') ? 'Lengkap' : 'Tidak Lengkap';

        const { error: insertErr } = await supabase.from('absensi').insert([{
          id: newId,
          tanggal: tglStr,
          jam_datang: jamStr,
          id_siswa: payload.idSiswa || '-',
          nama_siswa: payload.namaSiswa,
          kelas: payload.kelas,
          id_petugas: payload.idPetugas || '-',
          nama_petugas: payload.namaPetugas || '-',
          status_seragam: statusSeragamGlobal,
          badge_sekolah: payload.badgeSekolah || '-',
          badge_osis: payload.badgeOsis || '-',
          dasi: payload.dasi || '-',
          ikat_pinggang: payload.ikatPinggang || '-',
          kaos_kaki: payload.kaosKaki || '-',
          sepatu: payload.sepatu || '-',
          atribut_lainnya: payload.atributLainnya || '-',
          keterangan: payload.keterangan || '-',
          status_hp: payload.statusHp || 'HP Tidak Dikumpulkan',
          keterangan_hp: payload.keteranganHp || '-',
          foto_url: fotoUrl
        }]);

        if (insertErr) {
          return res.json({ success: false, message: 'Gagal menyimpan absensi: ' + insertErr.message });
        }

        await logAudit('PENGISIAN', newId, payload.namaPetugas || payload.idPetugas, `${payload.namaSiswa} / ${payload.kelas}`);

        const { data: siswaRow } = await supabase.from('siswa').select('no_wa_orang_tua').eq('id', payload.idSiswa).maybeSingle();
        const nomorOrtu = siswaRow && siswaRow.no_wa_orang_tua ? String(siswaRow.no_wa_orang_tua).trim() : '';
        let notifWa = { success: false, reason: 'Nomor WhatsApp orang tua belum diisi.' };

        if (nomorOrtu) {
          const pesan =
            '📢 *PEMBERITAHUAN KEHADIRAN SISWA*\n' +
            '━━━━━━━━━━━━━━━━━━\n\n' +
            'Assalamu’alaikum warahmatullahi wabarakatuh.\n\n' +
            'Yth. Bapak/Ibu Orang Tua/Wali,\n' +
            'Dengan hormat, kami informasikan bahwa putra/putri Bapak/Ibu telah tercatat hadir di sekolah dengan rincian berikut:\n\n' +
            `👤 *Nama Siswa:* ${payload.namaSiswa}\n` +
            `🏫 *Kelas:* ${payload.kelas}\n` +
            `📅 *Tanggal:* ${tglStr}\n` +
            `🕒 *Jam Kedatangan:* ${jamStr} WIB\n` +
            '✅ *Status:* HADIR\n' +
            `🧑‍💼 *Petugas OSIS:* ${payload.namaPetugas || 'Petugas Absensi'}\n\n` +
            'Terima kasih atas perhatian dan kerja sama Bapak/Ibu.\n' +
            '*OSIS SMK Dian Al Mustarih*';
          notifWa = await sendFonnteMessage(nomorOrtu, pesan);
        }

        return res.json({
          success: true,
          idAbsensi: newId,
          jam: jamStr,
          notifWa: notifWa.success,
          message: `ABSENSI BERHASIL! Data "${payload.namaSiswa}" (${payload.kelas}) telah tersimpan.` +
            (notifWa.success ? ' Notifikasi WhatsApp terkirim.' : ` (${notifWa.reason})`)
        });
      }

      case 'loginAdmin': {
        const [username, password] = args;
        return res.json(await loginAdminServer(username, password));
      }

      case 'getAdminDashboardData': {
        const [auth] = args;
        const isAnggotaReadOnly = await verifyAnggotaReadOnlyAuth(auth);
        if (!isAnggotaReadOnly && !(await verifyAdminAuth(auth, ROLE_SEMUA_ADMIN))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }

        const { tglStr } = getJakartaDateParts();
        const namaSekolah = await getSettingValue('NAMA_SEKOLAH', 'SMK DIAN AL MUSTARIH');
        const attendanceEnabled = await isAttendanceOpen();

        const [{ data: kelasRows }, { data: siswaRows }, { data: absenRows }, { data: petugasRows }] = await Promise.all([
          supabase.from('kelas').select('*').order('id', { ascending: true }),
          supabase.from('siswa').select('*').order('nama', { ascending: true }),
          supabase.from('absensi').select('*').order('created_at', { ascending: false }),
          supabase.from('petugas_osis').select('*').order('id', { ascending: true })
        ]);

        const listKelasDetail = (kelasRows || []).map(k => ({
          id: k.id, tingkat: k.tingkat, jurusan: k.jurusan, namaKelas: k.nama_kelas, status: k.status
        }));
        const listKelasNama = listKelasDetail.map(k => k.namaKelas);
        const statsPerKelas = {};
        listKelasNama.forEach(k => { statsPerKelas[k] = { totalAktif: 0, sudahAbsenHariIni: 0 }; });

        let totalSiswaAktif = 0;
        const listSiswaMaster = (siswaRows || []).map(s => {
          if (s.kelas && !listKelasNama.includes(s.kelas)) {
            listKelasNama.push(s.kelas);
            statsPerKelas[s.kelas] = { totalAktif: 0, sudahAbsenHariIni: 0 };
          }
          if (String(s.status || 'Aktif').toLowerCase() === 'aktif') {
            totalSiswaAktif++;
            if (s.kelas) statsPerKelas[s.kelas].totalAktif++;
          }
          return {
            id: s.id,
            nama: s.nama,
            kelas: s.kelas,
            status: s.status,
            qrToken: s.id,
            qrDriveUrl: s.qr_url || '',
            qrUrlTarget: originUrl ? `${originUrl}?scan_id=${encodeURIComponent(s.id)}` : s.id,
            waOrtu: s.no_wa_orang_tua || ''
          };
        });

        let sudahAbsenHariIni = 0;
        let seragamTidakLengkap = 0;
        const setSudah = new Set();
        const attendedIdsToday = [];
        const mapPetugasToday = {};
        const mapPetugasTotal = {};

        const listRekap = (absenRows || []).map(r => {
          if (r.id_petugas && r.id_petugas !== '-') {
            mapPetugasTotal[r.id_petugas] = (mapPetugasTotal[r.id_petugas] || 0) + 1;
            if (r.tanggal === tglStr) {
              mapPetugasToday[r.id_petugas] = (mapPetugasToday[r.id_petugas] || 0) + 1;
            }
          }
          if (r.tanggal === tglStr) {
            if (r.id_siswa && r.id_siswa !== '-') attendedIdsToday.push(r.id_siswa);
            const uKey = `${String(r.nama_siswa).toLowerCase()}|${String(r.kelas).toLowerCase()}`;
            if (!setSudah.has(uKey)) {
              setSudah.add(uKey);
              sudahAbsenHariIni++;
              if (r.kelas && statsPerKelas[r.kelas]) statsPerKelas[r.kelas].sudahAbsenHariIni++;
            }
            if (r.status_seragam !== 'Lengkap') seragamTidakLengkap++;
          }
          return {
            id: r.id,
            tanggal: r.tanggal,
            jamDatang: r.jam_datang,
            idSiswa: r.id_siswa,
            nama: r.nama_siswa,
            kelas: r.kelas,
            idPetugas: r.id_petugas,
            namaPetugas: r.nama_petugas,
            statusSeragam: r.status_seragam,
            badgeSekolah: r.badge_sekolah,
            badgeOsis: r.badge_osis,
            dasi: r.dasi,
            ikatPinggang: r.ikat_pinggang,
            kaosKaki: r.kaos_kaki,
            sepatu: r.sepatu,
            atributLainnya: r.atribut_lainnya,
            keterangan: r.keterangan,
            statusHp: r.status_hp,
            keteranganHp: r.keterangan_hp,
            fotoUrl: r.foto_url
          };
        });

        const listPetugas = (petugasRows || []).map(p => ({
          id: p.id,
          nama: p.nama,
          kode: p.kode,
          status: p.status,
          todayCount: mapPetugasToday[p.id] || 0,
          totalAll: mapPetugasTotal[p.id] || 0
        }));

        return res.json({
          success: true,
          namaSekolah,
          webAppUrl: originUrl,
          attendedIdsToday,
          attendanceEnabled,
          stats: {
            totalSiswa: totalSiswaAktif,
            sudahAbsen: sudahAbsenHariIni,
            belumAbsen: Math.max(0, totalSiswaAktif - sudahAbsenHariIni),
            seragamTidakLengkap,
            perKelas: statsPerKelas
          },
          listRekap,
          listKelas: listKelasNama,
          listKelasDetail,
          listPetugas,
          listSiswa: listSiswaMaster
        });
      }

      case 'simpanDataSiswa': {
        const [payload] = args;
        if (!payload || !(await verifyAdminAuth(payload.auth, ROLE_OPERASIONAL_PENUH))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }
        const cleanNama = String(payload.nama || '').trim();
        const cleanKelas = String(payload.kelas || '').trim();
        let cleanWa = String(payload.waOrtu || '').trim();
        if (cleanWa) cleanWa = normalizeFonnteTarget(cleanWa);

        if (payload.id) {
          const qrUrl = await generateAndUploadQrCode(payload.id, cleanNama, cleanKelas, originUrl);
          const updateData = { nama: cleanNama, kelas: cleanKelas, status: payload.status || 'Aktif', no_wa_orang_tua: cleanWa };
          if (qrUrl) updateData.qr_url = qrUrl;
          await supabase.from('siswa').update(updateData).eq('id', payload.id);
          return res.json({ success: true, message: 'Data siswa & QR Code berhasil diperbarui!' });
        } else {
          const { data: allSiswa } = await supabase.from('siswa').select('id');
          const newId = nextFormattedId(allSiswa, 'id', 'SIS-', 4);
          const qrUrl = await generateAndUploadQrCode(newId, cleanNama, cleanKelas, originUrl);
          await supabase.from('siswa').insert([{
            id: newId, nama: cleanNama, kelas: cleanKelas, status: payload.status || 'Aktif', no_wa_orang_tua: cleanWa, qr_url: qrUrl
          }]);
          return res.json({ success: true, message: 'Siswa baru & QR Code berhasil ditambahkan!' });
        }
      }

      case 'importDataSiswaMassal': {
        const [payload] = args;
        if (!payload || !(await verifyAdminAuth(payload.auth, ROLE_OPERASIONAL_PENUH))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const { data: existing } = await supabase.from('siswa').select('id, nama, kelas');
        const existingKeys = new Set((existing || []).map(s => `${s.nama.toLowerCase()}|${s.kelas.toLowerCase()}`));
        let maxNum = 0;
        (existing || []).forEach(r => {
          const n = parseInt(String(r.id).replace(/\D/g, ''), 10);
          if (!isNaN(n) && n > maxNum) maxNum = n;
        });

        const toInsert = [];
        let skipped = 0;
        for (const r of rows) {
          const nama = String(r.nama || '').trim();
          const kelas = String(r.kelas || '').trim().toUpperCase();
          if (!nama || !kelas) { skipped++; continue; }
          const key = `${nama.toLowerCase()}|${kelas.toLowerCase()}`;
          if (existingKeys.has(key)) { skipped++; continue; }
          existingKeys.add(key);

          let waOrtu = String(r.waOrtu || '').trim();
          if (waOrtu) { try { waOrtu = normalizeFonnteTarget(waOrtu); } catch (e) { waOrtu = ''; } }

          maxNum++;
          const newId = 'SIS-' + String(maxNum).padStart(4, '0');
          const qrUrl = payload.generateQrDrive !== false ? await generateAndUploadQrCode(newId, nama, kelas, originUrl) : '';
          toInsert.push({ id: newId, nama, kelas, status: r.status || 'Aktif', no_wa_orang_tua: waOrtu, qr_url: qrUrl });
        }

        if (toInsert.length > 0) {
          await supabase.from('siswa').insert(toInsert);
        }
        return res.json({
          success: true,
          message: `Import selesai: ${toInsert.length} siswa ditambahkan${skipped > 0 ? `, ${skipped} dilewati` : ''}.`
        });
      }

      case 'uploadQrCardToDrive': {
        const [payload] = args;
        if (!payload || !payload.base64Data) return res.json({ success: false, message: 'Data gambar tidak ditemukan.' });
        const fileName = payload.fileName || `Kartu_QR_${Date.now()}.png`;
        const url = await uploadBase64ToStorage('kartu-qr', fileName, payload.base64Data);
        if (payload.idSiswa) {
          await supabase.from('siswa').update({ qr_url: url }).eq('id', payload.idSiswa);
        }
        return res.json({ success: true, url, message: `Kartu QR berhasil diunggah (${fileName})` });
      }

      case 'simpanDataKelas': {
        const [payload] = args;
        if (!payload || !(await verifyAdminAuth(payload.auth, ROLE_OPERASIONAL_PENUH))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }
        const { data: allKelas } = await supabase.from('kelas').select('id');
        const newId = payload.id || nextFormattedId(allKelas, 'id', 'KLS-', 2);
        await supabase.from('kelas').upsert({
          id: newId,
          tingkat: String(payload.tingkat || '').toUpperCase(),
          jurusan: String(payload.jurusan || '').toUpperCase(),
          nama_kelas: String(payload.namaKelas || '').trim(),
          status: payload.status || 'Aktif'
        });
        return res.json({ success: true, message: 'Data kelas berhasil disimpan!' });
      }

      case 'simpanPetugasOSIS': {
        const [payload] = args;
        if (!payload || !(await verifyAdminAuth(payload.auth, ROLE_OPERASIONAL_PENUH))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }
        const { data: allPtg } = await supabase.from('petugas_osis').select('id');
        const newId = payload.id || nextFormattedId(allPtg, 'id', 'PTG-', 3);
        await supabase.from('petugas_osis').upsert({
          id: newId,
          nama: String(payload.nama || '').trim(),
          kode: String(payload.kode || '').trim(),
          status: payload.status || 'Aktif'
        });
        return res.json({ success: true, message: 'Data petugas OSIS berhasil disimpan!' });
      }

      case 'updateDataAbsensi': {
        const [payload] = args;
        if (!payload || !(await verifyAdminAuth(payload.auth, ROLE_SEMUA_ADMIN))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }
        const attrs = [payload.badgeSekolah, payload.badgeOsis, payload.dasi, payload.ikatPinggang, payload.kaosKaki, payload.sepatu, payload.atributLainnya];
        const statusGlobal = attrs.every(v => v === 'Lengkap') ? 'Lengkap' : 'Tidak Lengkap';
        await supabase.from('absensi').update({
          status_seragam: statusGlobal,
          badge_sekolah: payload.badgeSekolah,
          badge_osis: payload.badgeOsis,
          dasi: payload.dasi,
          ikat_pinggang: payload.ikatPinggang,
          kaos_kaki: payload.kaosKaki,
          sepatu: payload.sepatu,
          atribut_lainnya: payload.atributLainnya,
          keterangan: payload.keterangan || '-',
          status_hp: payload.statusHp,
          keterangan_hp: payload.keteranganHp || '-'
        }).eq('id', payload.id);
        await logAudit('PERUBAHAN', payload.id, payload.auth.username, 'Perubahan atribut/HP absensi');
        return res.json({ success: true, message: 'Pilihan absensi berhasil diperbarui!' });
      }

      case 'getViolationPointsData': {
        const [auth] = args;
        if (!(await verifyAdminAuth(auth, ROLE_SEMUA_ADMIN))) return res.json({ success: false, message: 'Akses ditolak.' });
        const { data: rows } = await supabase.from('absensi').select('*');
        const mapSiswa = {};
        let totalPoin = 0;
        let totalPelanggaran = 0;

        (rows || []).forEach(r => {
          const cols = [
            { name: 'Badge Sekolah', val: r.badge_sekolah },
            { name: 'Badge OSIS', val: r.badge_osis },
            { name: 'Dasi', val: r.dasi },
            { name: 'Ikat Pinggang', val: r.ikat_pinggang },
            { name: 'Kaos Kaki', val: r.kaos_kaki },
            { name: 'Sepatu', val: r.sepatu },
            { name: 'Atribut Lainnya', val: r.atribut_lainnya }
          ];
          const details = cols.filter(c => c.val === 'Tidak Lengkap').map(c => c.name + ' Tidak Lengkap');
          if (details.length > 0) {
            totalPoin += details.length;
            totalPelanggaran += details.length;
            const key = r.id_siswa !== '-' ? r.id_siswa : `${r.nama_siswa}|${r.kelas}`;
            if (!mapSiswa[key]) {
              mapSiswa[key] = { id: r.id_siswa, nama: r.nama_siswa, kelas: r.kelas, totalPoin: 0, jumlahPelanggaran: 0, riwayat: [] };
            }
            mapSiswa[key].totalPoin += details.length;
            mapSiswa[key].jumlahPelanggaran += details.length;
            mapSiswa[key].riwayat.push({ tanggal: r.tanggal, jam: r.jam_datang, detail: details.join(', '), poin: details.length });
          }
        });
        const list = Object.values(mapSiswa).sort((a, b) => b.totalPoin - a.totalPoin);
        return res.json({ success: true, summary: { totalPoin, siswaTercatat: list.length, totalPelanggaran }, list });
      }

      case 'getAttendanceControlStatus': {
        const [auth] = args;
        if (!(await verifyAdminAuth(auth, ROLE_OPERASIONAL_PENUH))) return res.json({ success: false, message: 'Akses ditolak.' });
        return res.json({ success: true, enabled: await isAttendanceOpen() });
      }

      case 'setAttendanceEnabled': {
        const [auth, enabled] = args;
        if (!(await verifyAdminAuth(auth, ROLE_OPERASIONAL_PENUH))) return res.json({ success: false, message: 'Akses ditolak.' });
        const boolEnabled = Boolean(enabled);
        await supabase.from('pengaturan').upsert({ key: 'ATTENDANCE_ENABLED', value: boolEnabled ? 'true' : 'false' });
        return res.json({ success: true, enabled: boolEnabled, message: boolEnabled ? 'Pengisian absensi dibuka.' : 'Pengisian absensi ditutup.' });
      }

      case 'getAdminAccounts': {
        const [auth] = args;
        if (!(await verifyAdminAuth(auth, ['Developer']))) return res.json({ success: false, message: 'Akses khusus Developer.' });
        const { data: rows } = await supabase.from('admin').select('id, username, role, status').order('id', { ascending: true });
        return res.json({ success: true, listAdmin: rows || [] });
      }

      case 'simpanAkunAdmin':
      case 'tambahAkunAdminPengawas': {
        const [payload] = args;
        const isDev = await verifyAdminAuth(payload.auth, ['Developer']);
        const isOp = await verifyAdminAuth(payload.auth, ROLE_OPERASIONAL_PENUH);
        if (!isDev && !isOp) return res.json({ success: false, message: 'Akses ditolak.' });
        if (!isDev && !['Pengawas', 'Ketua OSIS', 'Wakil OSIS', 'Anggota OSIS'].includes(payload.role)) {
          return res.json({ success: false, message: 'Role tidak diizinkan.' });
        }
        const { data: allAdm } = await supabase.from('admin').select('id');
        const newId = payload.id || nextFormattedId(allAdm, 'id', 'ADM-', 2);
        const upsertData = {
          id: newId,
          username: String(payload.username).trim(),
          role: payload.role,
          status: payload.status || 'Aktif'
        };
        if (payload.password) upsertData.password_hash = sha256(payload.password);
        await supabase.from('admin').upsert(upsertData);
        return res.json({ success: true, message: `Akun ${payload.role} berhasil disimpan!` });
      }

      case 'getJadwalPetugasHariIni': {
        const [auth] = args;
        if (!(await verifyAdminAuth(auth, ROLE_OPERASIONAL_PENUH))) return res.json({ success: false, message: 'Akses ditolak.' });
        const { data: rows } = await supabase.from('jadwal_petugas').select('*').order('id', { ascending: true });
        const listJadwal = (rows || []).map(r => ({
          rowIndex: r.id,
          hari: r.hari,
          idOrUser: r.id_atau_username,
          nama: r.nama_petugas,
          role: r.role,
          status: r.status
        }));
        return res.json({ success: true, listJadwal });
      }

      case 'simpanJadwalPetugas': {
        const [payload] = args;
        if (!payload || !(await verifyAdminAuth(payload.auth, ROLE_OPERASIONAL_PENUH))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }
        const hariStr = Array.isArray(payload.hari) ? payload.hari.join(', ') : String(payload.hari || '');
        if (payload.rowIndex) {
          await supabase.from('jadwal_petugas').update({
            hari: hariStr,
            id_atau_username: payload.idOrUser || '',
            nama_petugas: payload.nama,
            role: payload.role || 'Anggota OSIS',
            status: payload.status || 'Aktif'
          }).eq('id', payload.rowIndex);
        } else {
          await supabase.from('jadwal_petugas').insert([{
            hari: hariStr,
            id_atau_username: payload.idOrUser || '',
            nama_petugas: payload.nama,
            role: payload.role || 'Anggota OSIS',
            status: payload.status || 'Aktif'
          }]);
        }
        return res.json({ success: true, message: 'Jadwal petugas berhasil disimpan!' });
      }

      case 'hapusJadwalPetugas': {
        const [auth, rowIndex] = args;
        if (!(await verifyAdminAuth(auth, ROLE_OPERASIONAL_PENUH))) return res.json({ success: false, message: 'Akses ditolak.' });
        await supabase.from('jadwal_petugas').delete().eq('id', rowIndex);
        return res.json({ success: true, message: 'Jadwal petugas berhasil dihapus.' });
      }

      case 'getDaftarPersetujuanAbsensi': {
        const [auth] = args;
        if (!(await verifyAdminAuth(auth, ROLE_OPERASIONAL_PENUH))) return res.json({ success: false, message: 'Akses ditolak.' });
        const { data: rows } = await supabase.from('persetujuan_absensi').select('*').order('created_at', { ascending: false });
        const listRequest = (rows || []).map(r => ({
          id: r.id_request,
          waktu: r.waktu_request,
          pemohon: r.pemohon,
          role: r.role,
          namaSiswa: r.nama_siswa,
          kelas: r.kelas,
          status: r.status,
          diprosesOleh: r.diproses_oleh,
          alasan: r.alasan
        }));
        return res.json({ success: true, listRequest });
      }

      case 'prosesPersetujuanAbsensi': {
        const [auth, requestId, keputusan] = args;
        if (!(await verifyAdminAuth(auth, ROLE_OPERASIONAL_PENUH))) return res.json({ success: false, message: 'Akses ditolak.' });
        const { data: reqRow } = await supabase.from('persetujuan_absensi').select('*').eq('id_request', requestId).maybeSingle();
        if (!reqRow) return res.json({ success: false, message: 'ID Request tidak ditemukan.' });

        await supabase.from('persetujuan_absensi').update({
          status: keputusan,
          diproses_oleh: `${auth.username} (${auth.role})`
        }).eq('id_request', requestId);

        if (String(keputusan).toLowerCase() === 'disetujui') {
          const payloadAbsen = { ...reqRow.data_absensi_json, approvalApproved: true };
          req.body = { action: 'submitAbsensi', args: [payloadAbsen] };
          return handler(req, res);
        }
        return res.json({ success: true, message: `Permintaan ${requestId} telah DITOLAK.` });
      }

      case 'kirimBroadcastWaOrtu': {
        const [payload] = args;
        if (!payload || !(await verifyAdminAuth(payload.auth, ROLE_OPERASIONAL_PENUH))) {
          return res.json({ success: false, message: 'Akses ditolak.' });
        }
        const { tglStr } = getJakartaDateParts();
        const [{ data: siswaRows }, { data: absenToday }] = await Promise.all([
          supabase.from('siswa').select('*').eq('status', 'Aktif'),
          supabase.from('absensi').select('id_siswa, status_seragam').eq('tanggal', tglStr)
        ]);

        const sudahSet = new Set((absenToday || []).map(a => a.id_siswa));
        const kurangSet = new Set((absenToday || []).filter(a => a.status_seragam === 'Tidak Lengkap').map(a => a.id_siswa));

        const penerima = (siswaRows || []).filter(s => {
          if (!String(s.no_wa_orang_tua || '').trim()) return false;
          if (payload.targetMode === 'ALL') return true;
          if (payload.targetMode === 'KELAS') return s.kelas === payload.targetKelas;
          if (payload.targetMode === 'BELUM_ABSEN') return (!payload.targetKelas || s.kelas === payload.targetKelas) && !sudahSet.has(s.id);
          if (payload.targetMode === 'SERAGAM_KURANG') return (!payload.targetKelas || s.kelas === payload.targetKelas) && kurangSet.has(s.id);
          if (payload.targetMode === 'MANUAL_SELECT') return (payload.selectedIds || []).includes(s.id);
          return false;
        });

        let terkirim = 0, gagal = 0;
        for (const p of penerima) {
          const msg = String(payload.pesan || '').replace(/\{nama\}/gi, p.nama).replace(/\{kelas\}/gi, p.kelas);
          const resWa = await sendFonnteMessage(p.no_wa_orang_tua, msg);
          if (resWa.success) terkirim++; else gagal++;
        }
        return res.json({
          success: true,
          message: `Broadcast selesai: ${terkirim} berhasil terkirim, ${gagal} gagal dari total ${penerima.length} penerima.`
        });
      }

      default:
        return res.status(400).json({ success: false, message: `Action tidak dikenal: ${action}` });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};
