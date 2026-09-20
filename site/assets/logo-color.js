(function () {
  var STORAGE_KEY = "backspace-logo-base-v2";
  var DEFAULT_COLOR = "#0061ff";
  var HOLD_DELAY = 650;
  var SWATCHES = ["#0061ff", "#7c6cf6", "#8433ff", "#8f95a3", "#c0c7d2", "#06b6d4", "#10b981", "#f59e0b", "#fb7185", "#ec4899", "#f97316", "#14b8a6"];
  var root = document.documentElement;
  var picker = null;
  var colorInput = null;
  var valueLabel = null;
  var activeTarget = null;
  var holdTimer = null;
  var suppressNextClick = false;

  function validColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  function readStoredColor() {
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      return validColor(stored) ? stored : DEFAULT_COLOR;
    } catch (_) {
      return DEFAULT_COLOR;
    }
  }

  function writeStoredColor(value) {
    try { window.localStorage.setItem(STORAGE_KEY, value); } catch (_) {}
  }

  function setLogoBase(value, persist) {
    if (!validColor(value)) return;
    var normalized = value.toLowerCase();
    root.style.setProperty("--logo-base", normalized);
    if (colorInput) colorInput.value = normalized;
    if (valueLabel) valueLabel.textContent = normalized;
    if (persist) writeStoredColor(normalized);
  }

  setLogoBase(readStoredColor(), false);

  function ensurePicker() {
    if (picker) return picker;

    picker = document.createElement("div");
    picker.className = "logo-color-popover";
    picker.hidden = true;
    picker.setAttribute("role", "dialog");
    picker.setAttribute("aria-label", "Logo gradient color");

    var row = document.createElement("label");
    row.className = "logo-color-control";

    colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = readStoredColor();
    colorInput.setAttribute("aria-label", "Choose logo gradient base color");

    valueLabel = document.createElement("span");
    valueLabel.className = "logo-color-value";
    valueLabel.textContent = colorInput.value;

    row.appendChild(colorInput);
    row.appendChild(valueLabel);

    var swatches = document.createElement("div");
    swatches.className = "logo-color-swatches";
    SWATCHES.forEach(function (color) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "logo-color-swatch";
      button.style.setProperty("--swatch", color);
      button.setAttribute("aria-label", "Use " + color + " as logo gradient base");
      button.addEventListener("click", function () { setLogoBase(color, true); });
      swatches.appendChild(button);
    });

    colorInput.addEventListener("input", function () { setLogoBase(colorInput.value, true); });

    picker.appendChild(row);
    picker.appendChild(swatches);
    document.body.appendChild(picker);
    return picker;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function placePicker(target) {
    var pop = ensurePicker();
    var rect = target.getBoundingClientRect();
    var width = pop.offsetWidth || 244;
    var height = pop.offsetHeight || 128;
    var gap = 10;
    var left = clamp(rect.left + rect.width / 2 - width / 2, 12, window.innerWidth - width - 12);
    var top = rect.bottom + gap;
    if (top + height + 12 > window.innerHeight) top = Math.max(12, rect.top - height - gap);
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  }

  function openPicker(target) {
    activeTarget = target;
    var pop = ensurePicker();
    pop.hidden = false;
    placePicker(target);
    pop.classList.remove("is-open");
    void pop.offsetWidth;
    pop.classList.add("is-open");
  }

  function closePicker() {
    if (!picker || picker.hidden) return;
    picker.hidden = true;
    picker.classList.remove("is-open");
  }

  function clearHoldTimer() {
    if (holdTimer !== null) {
      window.clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function scheduleOpen(target, mode) {
    clearHoldTimer();
    activeTarget = target;
    holdTimer = window.setTimeout(function () {
      holdTimer = null;
      if (mode === "hold") suppressNextClick = true;
      openPicker(target);
    }, HOLD_DELAY);
  }

  document.querySelectorAll(".brand .logo-mark").forEach(function (target) {
    var brand = target.closest(".brand");

    target.addEventListener("pointerdown", function () { scheduleOpen(target, "hold"); });
    target.addEventListener("pointerleave", clearHoldTimer);
    target.addEventListener("pointerup", clearHoldTimer);
    target.addEventListener("pointercancel", clearHoldTimer);

    if (brand) {
      brand.addEventListener("click", function (event) {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }
  });

  document.addEventListener("pointerdown", function (event) {
    if (!picker || picker.hidden) return;
    if (picker.contains(event.target)) return;
    if (activeTarget && activeTarget.contains(event.target)) return;
    closePicker();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closePicker();
  });

  window.addEventListener("resize", function () {
    if (picker && !picker.hidden && activeTarget) placePicker(activeTarget);
  });
})();
