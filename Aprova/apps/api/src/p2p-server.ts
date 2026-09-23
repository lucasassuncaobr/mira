// Servidor de sinalização PeerJS — aperta a mão WebRTC entre os usuários e
// sai da conexão: depois do handshake, os dados (JSON de metadados e pacotes
// de imagens) fluem em P2P pelo DataChannel, sem passar pelo servidor.
//
// Rodar:  npm run p2p -w apps/api   (porta 9000, path /sinalizar)
import { PeerServer } from "peer";

const PORT = Number(process.env.P2P_PORT ?? 9000);
const PATH = process.env.P2P_PATH ?? "/sinalizar";

const peerServer = PeerServer({
  port: PORT,
  path: PATH,
  allow_discovery: true,
  // Ativar se usar Cloudflare/Nginx em produção.
  proxied: process.env.P2P_PROXIED === "1",
});

peerServer.on("connection", (client) => {
  console.log(`[p2p] Usuário conectado ao canal de sinalização: ${client.getId()}`);
});

peerServer.on("disconnect", (client) => {
  console.log(`[p2p] Usuário desconectado: ${client.getId()}`);
});

console.log(`[p2p] Sinalização PeerJS em http://localhost:${PORT}${PATH}`);
