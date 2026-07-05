// src/ui/ChatUI.js
// AI Chatbot UI (Gemini via /api/chat).
// Extracted from 3DFloorGenerator/frontend/index.html

import { sendChatMessage } from '../services/materialApi.js';

// Current element context set by StructuralPanel when a wall is opened
let _currentEl = null;

/** Called by StructuralPanel.openPanel() to set context and seed greeting. */
export function setChatElement(el) {
  _currentEl = el;
  const messages = document.getElementById('chat-messages');
  if (!messages) return;
  messages.innerHTML = '';
  appendMsg(
    'ai',
    `Hi! I'm looking at ${el.element_id} (${el.element_type.replace(/_/g, ' ')}). ` +
    `The top recommendation is ${(el.recommendations || [])[0]?.material || '—'} ` +
    `with a score of ${(el.recommendations || [])[0]?.score?.toFixed(3) || '—'}. ` +
    `Ask me anything about materials, structural role, or cost tradeoffs.`
  );
}

/** Append a message bubble to the chat list. Returns the div element. */
export function appendMsg(role, text) {
  const messages = document.getElementById('chat-messages');
  if (!messages) return null;
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  div.textContent = text;
  messages.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth' });
  return div;
}

/** Called by button click or Enter key — reads input, calls API, renders reply. */
export async function sendChat() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  if (!input) return;
  const q = input.value.trim();
  if (!q || !_currentEl) return;

  input.value = '';
  if (sendBtn) sendBtn.disabled = true;
  appendMsg('user', q);

  const thinking = appendMsg('ai', 'Thinking…');
  if (thinking) thinking.classList.add('thinking');

  try {
    const answer = await sendChatMessage(q, _currentEl);
    if (thinking) thinking.remove();
    appendMsg('ai', answer);
  } catch (e) {
    if (thinking) thinking.remove();
    appendMsg('ai', `Could not reach backend: ${e.message}`);
  }

  if (sendBtn) sendBtn.disabled = false;
  if (input) input.focus();
}

/** Wire Enter key on the chat textarea. Call once after DOM is ready. */
export function initChatInputHandlers() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', sendChat);
  }
}
