// Emails group members when an event is proposed to their group, via Resend's
// REST API (no SDK needed). Non-fatal by design — the proposal already
// succeeded client-side; a failure here just means no email went out.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const { emails = [], proposerName = 'Someone', eventTitle = 'an event', groupName = 'your group', appUrl = '' } = req.body || {};
  const list = (Array.isArray(emails) ? emails : []).filter((e) => /\S+@\S+\.\S+/.test(e)).slice(0, 50);
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM || !list.length) {
    res.status(200).json({ sent: 0, skipped: true });
    return;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: process.env.RESEND_FROM, // bcc the recipients to keep addresses private
        bcc: list,
        subject: `${proposerName} proposed "${eventTitle}" to ${groupName}`,
        html: `<p><strong>${proposerName}</strong> proposed <strong>${eventTitle}</strong> to your group <strong>${groupName}</strong> on Hangouts.</p><p><a href="${appUrl}">Open Hangouts</a> to RSVP.</p>`,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      res.status(200).json({ sent: 0, error: t.slice(0, 200) });
      return;
    }
    res.status(200).json({ sent: list.length });
  } catch (e) {
    res.status(200).json({ sent: 0, error: e.message });
  }
}
