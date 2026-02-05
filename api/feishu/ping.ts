export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'contactprint',
    endpoint: 'feishu-ping',
    time: new Date().toISOString(),
  })
}
