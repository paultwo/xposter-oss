const token = document.querySelector('meta[name="csrf"]')?.getAttribute("content") ?? "";

function setBusy(form, busy) {
  const button = form.querySelector("button[type='submit']");
  if (!button) return;
  if (busy) {
    button.dataset.original = button.textContent ?? "";
    button.textContent = button.dataset.busy || "Saving…";
    button.setAttribute("aria-busy", "true");
    form.setAttribute("aria-busy", "true");
    return;
  }
  button.textContent = button.dataset.original || button.textContent;
  button.removeAttribute("aria-busy");
  form.removeAttribute("aria-busy");
}

function linkParts(value) {
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  const parts = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ type: "text", value: value.slice(cursor, start) });
    parts.push({ type: "link", value: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

function fillLinked(node, value) {
  node.replaceChildren();
  for (const part of linkParts(value)) {
    if (part.type === "text") {
      node.append(document.createTextNode(part.value));
      continue;
    }
    const anchor = document.createElement("a");
    anchor.className = "post-link";
    anchor.href = part.value;
    anchor.textContent = part.value;
    node.append(anchor);
  }
}

function fillCard(card, value) {
  if (!(card instanceof HTMLElement)) return;
  const match = value.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) {
    card.hidden = true;
    return;
  }
  let host = match[0];
  let path = "";
  try {
    const parsed = new URL(match[0]);
    host = parsed.host;
    path = `${parsed.pathname}${parsed.search}`;
    if (path === "/") path = "";
  } catch {
    host = match[0];
  }
  const hostNode = card.querySelector("[data-live='host']");
  const pathNode = card.querySelector("[data-live='path']");
  if (hostNode) hostNode.textContent = host;
  if (pathNode) {
    pathNode.textContent = path;
    pathNode.hidden = path.length === 0;
  }
  card.hidden = false;
}

async function refreshCount(textarea) {
  const targetId = textarea.getAttribute("data-count");
  if (!targetId) return;
  const response = await fetch("/api/count", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-csrf-token": token,
    },
    body: JSON.stringify({
      text: textarea.value,
      kind: document.getElementById("kind") instanceof HTMLSelectElement
        ? document.getElementById("kind").value
        : "post",
    }),
  });
  if (!response.ok) return;
  const data = await response.json();
  const target = document.getElementById(targetId);
  if (!target) return;
  const weighted = Number(data.weighted);
  const limit = Number(data.limit);
  const over = Boolean(data.over);
  const line = over
    ? `${weighted.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")}. Over by ${(weighted - limit).toLocaleString("en-US")}. Split it into a thread or make it an Article.`
    : `${weighted.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")}`;
  target.textContent = line;
  target.classList.toggle("over", over);
  const index = targetId.replace("count-", "");
  const previewCount = document.querySelector(`#live-preview [data-count-for="${index}"]`);
  if (previewCount) {
    previewCount.textContent = line;
    previewCount.classList.toggle("over", over);
  }
  const post = previewCount?.closest(".x-post");
  const textNode = post?.querySelector("[data-live='text']");
  const more = post?.querySelector("[data-live='more']");
  const restNode = post?.querySelector("[data-live='rest']");
  const shown = typeof data.head === "string" ? data.head : textarea.value;
  if (textNode) fillLinked(textNode, shown);
  if (more instanceof HTMLElement && restNode) {
    const rest = typeof data.rest === "string" ? data.rest : "";
    fillLinked(restNode, rest);
    more.hidden = rest.length === 0;
  }
  fillCard(post?.querySelector("[data-live='card']"), textarea.value);
  const live = document.getElementById("limit-live");
  if (live && over) live.textContent = `Over by ${(weighted - limit).toLocaleString("en-US")}. Split it into a thread or make it an Article.`;
  if (live && !over && live.textContent) live.textContent = "";
  const choices = document.getElementById("long-post-choices");
  if (choices instanceof HTMLElement) {
    const fields = document.querySelectorAll("textarea[data-count]");
    let past = Boolean(data.pastStandard);
    fields.forEach((field) => {
      if (field === textarea) return;
      if (field instanceof HTMLTextAreaElement && field.dataset.past === "1") past = true;
    });
    textarea.dataset.past = data.pastStandard ? "1" : "0";
    choices.hidden = !past;
  }
  const keep = document.getElementById("keep-long");
  if (keep instanceof HTMLButtonElement) {
    keep.disabled = !data.longPosts || over;
  }
}

const countTimers = new WeakMap();
document.addEventListener("input", (event) => {
  const textarea = event.target;
  if (!(textarea instanceof HTMLTextAreaElement) || !textarea.hasAttribute("data-count")) return;
  syncLive();
  window.clearTimeout(countTimers.get(textarea));
  countTimers.set(
    textarea,
    window.setTimeout(() => {
      refreshCount(textarea).catch(() => undefined);
    }, 250),
  );
});

const segments = document.getElementById("segments");
const template = document.getElementById("segment-template");
const countField = document.getElementById("segment-count");
document.getElementById("add-segment")?.addEventListener("click", () => {
  if (!segments || !template || !countField || !(template instanceof HTMLTemplateElement)) return;
  const next = segments.querySelectorAll("fieldset").length;
  if (next >= 25) return;
  const html = template.innerHTML.replaceAll("__I__", String(next)).replaceAll("__N__", String(next + 1));
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const fieldset = wrapper.firstElementChild;
  if (fieldset) segments.appendChild(fieldset);
  countField.value = String(next + 1);
  const added = segments.querySelectorAll("textarea[data-count]");
  const last = added[added.length - 1];
  if (last instanceof HTMLTextAreaElement) last.focus();
  renumberSegments();
  syncLive();
});

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest(".remove-segment") : null;
  if (!button || !segments || !countField) return;
  const fieldset = button.closest("fieldset");
  if (!fieldset) return;
  const position = [...segments.querySelectorAll("fieldset")].indexOf(fieldset);
  fieldset.remove();
  renumberSegments();
  const remaining = segments.querySelectorAll("fieldset textarea");
  const focusTarget = remaining[Math.max(0, position - 1)];
  if (focusTarget instanceof HTMLTextAreaElement) focusTarget.focus();
  const live = document.getElementById("limit-live");
  if (live) live.textContent = `Post ${position + 1} removed.`;
  syncLive();
});

function renumberSegments() {
  if (!segments || !countField) return;
  const fieldsets = segments.querySelectorAll("fieldset");
  fieldsets.forEach((fieldset, index) => {
    const legend = fieldset.querySelector("legend");
    if (legend) legend.textContent = `Post ${index + 1} of ${fieldsets.length}`;
    const remove = fieldset.querySelector(".remove-segment");
    if (remove) remove.textContent = `Remove post ${index + 1}`;
    fieldset.querySelectorAll("[name]").forEach((element) => {
      const name = element.getAttribute("name") ?? "";
      element.setAttribute("name", name.replace(/^(text|file|alt|media)_\d+/, `$1_${index}`));
    });
    for (const attribute of ["id", "for", "data-count", "aria-describedby"]) {
      fieldset.querySelectorAll(`[${attribute}]`).forEach((element) => {
        const value = element.getAttribute(attribute) ?? "";
        element.setAttribute(attribute, value.replace(/\b(text-error|alt-error|text|file|alt|count)-\d+/g, `$1-${index}`));
      });
    }
  });
  countField.value = String(fieldsets.length);
}

document.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
  const frame = input.closest(".image-fields");
  const preview = frame?.querySelector("img.preview");
  const file = input.files?.[0];
  if (!(preview instanceof HTMLImageElement) || !file) return;
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  syncLive();
});

document.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.name.startsWith("alt_")) return;
  syncLive();
});

const postNow = document.getElementById("post-now");
document.getElementById("open-post-now")?.addEventListener("click", () => {
  if (!(postNow instanceof HTMLDialogElement)) return;
  const opener = document.getElementById("open-post-now");
  const count = Number(opener?.dataset.count || "1");
  const kind = opener?.dataset.kind || "post";
  const user = opener?.dataset.user || "";
  const zone = opener?.dataset.zone || "America/New_York";
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(Date.now() + 60_000));
  const title = document.getElementById("post-now-title");
  const noun = kind === "article" ? "Article" : kind === "thread" ? "thread" : "post";
  if (title) {
    title.textContent = user
      ? `Post this ${noun} to @${user} now?`
      : `Post this ${noun} now?`;
  }
  const slot = document.getElementById("post-now-line");
  if (slot) {
    slot.textContent =
      kind === "article"
        ? `This Article goes live on X at about ${when}. You can't undo this here.`
        : `${count === 1 ? "1 post goes" : `${count} posts go`} live on X at about ${when}. You can't undo this here.`;
  }
  openDialog(postNow, opener);
});
document.getElementById("close-post-now")?.addEventListener("click", () => {
  if (postNow instanceof HTMLDialogElement) postNow.close();
});

const disconnect = document.getElementById("disconnect");
const disconnectDialog = document.getElementById("disconnect-dialog");
disconnect?.addEventListener("click", (event) => {
  if (!(disconnectDialog instanceof HTMLDialogElement)) return;
  event.preventDefault();
  openDialog(disconnectDialog, disconnect);
});
document.getElementById("close-disconnect")?.addEventListener("click", () => {
  if (disconnectDialog instanceof HTMLDialogElement) disconnectDialog.close();
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.dataset.submitting === "1") {
    event.preventDefault();
    return;
  }
  form.dataset.submitting = "1";
  const field = form.querySelector("input[name='csrf']");
  if (field instanceof HTMLInputElement && token) field.value = token;
  setBusy(form, true);
});

const dialogOpeners = new WeakMap();

function cancelButton(dialog) {
  const buttons = [...dialog.querySelectorAll("button")];
  return buttons.find((button) => (button.textContent ?? "").trim() === "Cancel") ?? null;
}

function tabbables(dialog) {
  return [...dialog.querySelectorAll("a[href], button, input, select, textarea")].filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.closest("[hidden]")) return false;
    if (node instanceof HTMLInputElement && node.type === "hidden") return false;
    if (node.hasAttribute("disabled")) return false;
    if ("disabled" in node && node.disabled === true) return false;
    return true;
  });
}

function openDialog(dialog, opener) {
  if (!(dialog instanceof HTMLDialogElement)) return;
  if (opener instanceof HTMLElement) dialogOpeners.set(dialog, opener);
  dialog.showModal();
  const cancel = cancelButton(dialog);
  if (cancel) cancel.focus();
}

function bindDialogElement(dialog) {
  if (!(dialog instanceof HTMLDialogElement) || dialog.dataset.bound === "1") return;
  dialog.dataset.bound = "1";
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const items = tabbables(dialog);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener("close", () => {
    const opener = dialogOpeners.get(dialog);
    if (opener instanceof HTMLElement) opener.focus();
  });
}

document.querySelectorAll("dialog").forEach((dialog) => bindDialogElement(dialog));

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const open = [...document.querySelectorAll("dialog")].find((dialog) => dialog instanceof HTMLDialogElement && dialog.open);
  if (!(open instanceof HTMLDialogElement)) return;
  event.preventDefault();
  open.close();
}, true);

function bindDialog(openId, dialogId, closeId) {
  const dialog = document.getElementById(dialogId);
  const opener = document.getElementById(openId);
  opener?.addEventListener("click", (event) => {
    if (!(dialog instanceof HTMLDialogElement)) return;
    event.preventDefault();
    openDialog(dialog, opener);
  });
  document.getElementById(closeId)?.addEventListener("click", () => {
    if (dialog instanceof HTMLDialogElement) dialog.close();
  });
}
bindDialog("open-archive", "archive-dialog", "close-archive");
bindDialog("open-pause", "pause-dialog", "close-pause");

document.addEventListener("click", (event) => {
  const opener = event.target instanceof Element ? event.target.closest(".open-dialog") : null;
  if (!(opener instanceof HTMLElement)) return;
  const dialog = document.getElementById(opener.dataset.dialog ?? "");
  if (!(dialog instanceof HTMLDialogElement)) return;
  const slot = dialog.querySelector("[data-preview-slot]");
  if (slot && opener.dataset.preview) slot.textContent = opener.dataset.preview;
  openDialog(dialog, opener);
});
document.addEventListener("click", (event) => {
  const closer = event.target instanceof Element ? event.target.closest(".close-dialog") : null;
  if (!closer) return;
  const dialog = closer.closest("dialog");
  if (dialog instanceof HTMLDialogElement) dialog.close();
});
document.addEventListener("click", (event) => {
  const opener = event.target instanceof Element ? event.target.closest(".open-resend") : null;
  if (!(opener instanceof HTMLElement)) return;
  const dialog = document.getElementById(opener.dataset.dialog ?? "");
  if (dialog instanceof HTMLDialogElement) openDialog(dialog, opener);
});
document.addEventListener("click", (event) => {
  const closer = event.target instanceof Element ? event.target.closest(".close-resend") : null;
  if (!closer) return;
  const dialog = closer.closest("dialog");
  if (dialog instanceof HTMLDialogElement) dialog.close();
});

const kindField = document.getElementById("kind");
function syncKind() {
  const field = document.getElementById("title-field");
  if (!(field instanceof HTMLElement) || !(kindField instanceof HTMLSelectElement)) return;
  field.hidden = kindField.value !== "article";
  const choices = document.getElementById("long-post-choices");
  if (choices instanceof HTMLElement && kindField.value === "article") {
    choices.hidden = true;
  }
}
kindField?.addEventListener("change", syncKind);
syncKind();

function syncLive() {
  const root = document.getElementById("live-preview");
  const source = document.getElementById("live-post-template");
  const form = document.getElementById("segments");
  if (!root || !(source instanceof HTMLTemplateElement) || !form) return;
  const list = document.createElement("ol");
  list.className = "x-preview";
  const fieldsets = [...form.querySelectorAll("fieldset")];
  list.setAttribute("aria-label", fieldsets.length > 1 ? `Thread, ${fieldsets.length} posts` : "Post");
  fieldsets.forEach((fieldset, index) => {
    const node = source.content.firstElementChild?.cloneNode(true);
    if (!(node instanceof HTMLElement)) return;
    if (fieldsets.length > 1) node.classList.add("threaded");
    const text = fieldset.querySelector("textarea");
    const value = text instanceof HTMLTextAreaElement ? text.value : "";
    const textNode = node.querySelector("[data-live='text']");
    if (textNode) fillLinked(textNode, value);
    fillCard(node.querySelector("[data-live='card']"), value);
    const alt = fieldset.querySelector("input[name^='alt_']");
    const filePreview = fieldset.querySelector("img.preview, .image-fields img");
    const figure = node.querySelector("[data-live='figure']");
    const image = node.querySelector("[data-live='img']");
    const altNode = node.querySelector("[data-live='alt']");
    const altText = alt instanceof HTMLInputElement ? alt.value : "";
    const shown = filePreview instanceof HTMLImageElement && filePreview.src && !filePreview.hidden && filePreview.getAttribute("src");
    if (figure instanceof HTMLElement && image instanceof HTMLImageElement && shown) {
      image.src = filePreview.src;
      image.alt = altText;
      if (altNode) altNode.textContent = altText;
      figure.hidden = false;
    }
    const count = node.querySelector("[data-live='count']");
    if (count instanceof HTMLElement) count.dataset.countFor = String(index);
    list.appendChild(node);
  });
  root.replaceChildren(list);
}

syncLive();
document.querySelectorAll("textarea[data-count]").forEach((textarea) => {
  if (textarea instanceof HTMLTextAreaElement && textarea.value.trim()) {
    refreshCount(textarea).catch(() => undefined);
  }
});

const summary = document.getElementById("error-summary");
if (summary instanceof HTMLElement) summary.focus();
