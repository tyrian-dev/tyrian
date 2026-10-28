import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const BASE_URL = process.env.BACKEND_URL || "http://127.0.0.1:3001";
const account = privateKeyToAccount(generatePrivateKey());

function getSessionCookie(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const match = cookie.match(/^tyrian_session=([^;]+)/);
    if (match) return `tyrian_session=${match[1]}`;
  }
  return null;
}

async function json(response) {
  return response.json().catch(() => ({}));
}

async function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, got ${response.status}: ${await response.text()}`,
    );
  }
}

async function main() {
  const health = await fetch(`${BASE_URL}/api/auth/me`);
  assert.equal(health.status, 200, "backend health check failed");

  const nonceResponse = await fetch(`${BASE_URL}/api/auth/nonce`);
  assert.equal(nonceResponse.status, 200, "nonce request failed");
  const { nonce } = await json(nonceResponse);
  assert.ok(nonce, "nonce missing");

  const message = createSiweMessage({
    address: account.address,
    chainId: 46630,
    domain: "localhost:3001",
    nonce,
    uri: `${BASE_URL}/`,
    version: "1",
    statement: "QA sign-in for Tyrian key lifecycle.",
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 5 * 60 * 1000),
  });
  const signature = await account.signMessage({ message });

  const verifyResponse = await fetch(`${BASE_URL}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature, address: account.address }),
  });
  await expectStatus(verifyResponse, 200, "verify");
  const verified = await json(verifyResponse);
  assert.equal(verified.address, account.address.toLowerCase());

  const cookie = getSessionCookie(verifyResponse);
  assert.ok(cookie, "session cookie missing");

  const replayResponse = await fetch(`${BASE_URL}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature, address: account.address }),
  });
  assert.equal(replayResponse.status, 401, "used nonce must not be accepted twice");

  const me = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await json(me)).authenticated, true, "session not visible through /me");

  const sessionQuota = await fetch(`${BASE_URL}/v1/quota`, {
    headers: { Cookie: cookie },
  });
  await expectStatus(sessionQuota, 200, "session quota");
  const quotaData = await json(sessionQuota);
  assert.equal(quotaData.userAddress, account.address.toLowerCase());

  const sessionChat = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "session chat" }],
      stream: true,
    }),
  });
  await expectStatus(sessionChat, 200, "session chat");
  await sessionChat.text();

  const unauthorizedCreate = await fetch(`${BASE_URL}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "unauthorized" }),
  });
  assert.equal(unauthorizedCreate.status, 401, "create without session must be 401");

  const createResponse = await fetch(`${BASE_URL}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "qa-key" }),
  });
  await expectStatus(createResponse, 200, "create");
  const created = await json(createResponse);
  assert.ok(created.apiKey?.startsWith("tyr_live_"), "raw key missing");
  assert.ok(created.id, "key id missing");

  const listResponse = await fetch(`${BASE_URL}/api/keys`, { headers: { Cookie: cookie } });
  const list = await json(listResponse);
  assert.equal(list.keys.length, 1, "created key not listed");
  assert.equal(list.keys[0].keyHash, undefined, "keyHash must not leak");

  const oldKeyCall = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${created.apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  });
  assert.equal(oldKeyCall.status, 200, "new key should authenticate");
  await oldKeyCall.text();

  const rotateResponse = await fetch(`${BASE_URL}/api/keys/${created.id}/rotate`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  await expectStatus(rotateResponse, 200, "rotate");
  const rotated = await json(rotateResponse);
  assert.ok(rotated.apiKey?.startsWith("tyr_live_"), "rotated raw key missing");
  assert.notEqual(rotated.apiKey, created.apiKey, "rotated key must differ");

  const revokedOldCall = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${created.apiKey}`,
    },
    body: JSON.stringify({ model: "deepseek/deepseek-chat", messages: [] }),
  });
  assert.equal(revokedOldCall.status, 401, "rotated old key must be revoked");

  const rotatedCall = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${rotated.apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "rotated" }],
      stream: true,
    }),
  });
  assert.equal(rotatedCall.status, 200, "rotated key should authenticate");
  await rotatedCall.text();

  const revokeResponse = await fetch(`${BASE_URL}/api/keys/${created.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  await expectStatus(revokeResponse, 200, "revoke");

  const revokedRotatedCall = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${rotated.apiKey}`,
    },
    body: JSON.stringify({ model: "deepseek/deepseek-chat", messages: [] }),
  });
  assert.equal(revokedRotatedCall.status, 401, "revoked key must be rejected");

  const emptyList = await json(await fetch(`${BASE_URL}/api/keys`, { headers: { Cookie: cookie } }));
  assert.equal(emptyList.keys.length, 0, "revoked key should disappear from active list");

  const logoutResponse = await fetch(`${BASE_URL}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(logoutResponse.status, 200);
  const loggedOut = await json(
    await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: cookie } }),
  );
  assert.equal(loggedOut.authenticated, false, "logout did not destroy session");

  const loggedOutChat = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ model: "deepseek/deepseek-chat", messages: [] }),
  });
  assert.equal(loggedOutChat.status, 401, "logged-out session must not authenticate");

  console.log("qa-auth-keys: PASS");
  console.log(JSON.stringify({ address: account.address, keyId: created.id }, null, 2));
}

main().catch((error) => {
  console.error("qa-auth-keys: FAIL");
  console.error(error);
  process.exitCode = 1;
});
