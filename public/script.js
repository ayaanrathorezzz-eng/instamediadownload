const form = document.querySelector("#form");
const input = document.querySelector("#url");
const submit = document.querySelector("#submit");
const statusBox = document.querySelector("#status");
const result = document.querySelector("#result");
const thumb = document.querySelector("#thumb");
const previewVideo = document.querySelector("#previewVideo");
const noPreview = document.querySelector("#noPreview");
const videoBtn = document.querySelector("#videoBtn");
const thumbBtn = document.querySelector("#thumbBtn");

function isInstagramUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return u.protocol === "https:" &&
      (host === "instagram.com" || host.endsWith(".instagram.com"));
  } catch {
    return false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = input.value.trim();
  result.classList.add("hidden");

  if (!isInstagramUrl(url)) {
    statusBox.textContent = "Please paste a valid HTTPS Instagram URL.";
    return;
  }

  submit.disabled = true;
  statusBox.textContent = "Fetching public media…";

  try {
    const response = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    if (!data.videoUrl && !data.thumbnailUrl) {
      throw new Error("The provider returned no usable media for this link.");
    }

    // Reset preview state.
    thumb.hidden = true;
    previewVideo.hidden = true;
    noPreview.hidden = true;
    previewVideo.removeAttribute("src");
    previewVideo.removeAttribute("poster");

    if (data.thumbnailUrl) {
      thumb.src = data.thumbnailUrl;
      thumb.hidden = false;
      thumbBtn.href = data.thumbnailDownloadUrl || data.thumbnailUrl;
      thumbBtn.style.display = "";
      thumb.onerror = () => {
        thumb.hidden = true;
        noPreview.hidden = false;
      };
    } else {
      thumbBtn.style.display = "none";
      if (data.videoUrl) {
        previewVideo.src = data.videoUrl;
        previewVideo.hidden = false;
      } else {
        noPreview.hidden = false;
      }
    }

    if (data.videoUrl) {
      videoBtn.href = data.videoUrl;
      videoBtn.style.display = "";
    } else {
      videoBtn.style.display = "none";
    }

    result.classList.remove("hidden");
    statusBox.textContent = data.title
      ? `Found: ${data.title.slice(0, 80)}`
      : "Media ready.";
  } catch (error) {
    statusBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
