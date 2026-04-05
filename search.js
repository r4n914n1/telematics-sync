"use strict";

(function bootstrapLocationSearch(global) {
  function initLocationSearch(map) {
    if (!map || typeof L === "undefined") {
      return;
    }

    const locationSearchForm = document.getElementById("location-search-form");
    const locationSearchInput = document.getElementById("location-search-input");
    const locationSearchSuggestions = document.getElementById("location-search-suggestions");

    if (!locationSearchForm || !locationSearchInput || !locationSearchSuggestions) {
      return;
    }

    let locationSearchHighlight = null;
    let locationSearchHighlightTimeoutId = null;
    let locationSearchDebounceId = null;
    let locationSearchRequestToken = 0;
    let googleMapsLoaderPromise = null;
    let googleAutocompleteService = null;
    let googleGeocoderService = null;

    async function loadGoogleMapsProvider() {
      if (googleMapsLoaderPromise) {
        return googleMapsLoaderPromise;
      }

      const firebaseApiKey = typeof firebaseConfig !== "undefined" ? String(firebaseConfig.apiKey || "") : "";
      const googleApiKey = String(global.GOOGLE_MAPS_API_KEY || firebaseApiKey).trim();

      if (!googleApiKey) {
        return false;
      }

      if (global.google?.maps?.Geocoder && global.google?.maps?.places?.AutocompleteService) {
        googleGeocoderService = new global.google.maps.Geocoder();
        googleAutocompleteService = new global.google.maps.places.AutocompleteService();
        return true;
      }

      googleMapsLoaderPromise = new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleApiKey)}&libraries=places`;
        script.async = true;
        script.defer = true;

        script.onload = () => {
          if (global.google?.maps?.Geocoder && global.google?.maps?.places?.AutocompleteService) {
            googleGeocoderService = new global.google.maps.Geocoder();
            googleAutocompleteService = new global.google.maps.places.AutocompleteService();
            resolve(true);
          } else {
            resolve(false);
          }
        };

        script.onerror = () => {
          resolve(false);
        };

        document.head.appendChild(script);
      });

      return googleMapsLoaderPromise;
    }

    function googleGeocodeAddress(query) {
      return new Promise((resolve) => {
        if (!googleGeocoderService || !global.google?.maps) {
          resolve(null);
          return;
        }

        googleGeocoderService.geocode({ address: query }, (results, status) => {
          if (status !== "OK" || !Array.isArray(results) || results.length === 0) {
            resolve(null);
            return;
          }

          const top = results[0];
          const location = top.geometry?.location;
          if (!location) {
            resolve(null);
            return;
          }

          resolve({
            lat: location.lat(),
            lon: location.lng(),
            label: String(top.formatted_address || query)
          });
        });
      });
    }

    function googleGeocodePlaceId(placeId, fallbackLabel) {
      return new Promise((resolve) => {
        if (!googleGeocoderService || !placeId) {
          resolve(null);
          return;
        }

        googleGeocoderService.geocode({ placeId }, (results, status) => {
          if (status !== "OK" || !Array.isArray(results) || results.length === 0) {
            resolve(null);
            return;
          }

          const top = results[0];
          const location = top.geometry?.location;
          if (!location) {
            resolve(null);
            return;
          }

          resolve({
            lat: location.lat(),
            lon: location.lng(),
            label: String(top.formatted_address || fallbackLabel || "Lokacija")
          });
        });
      });
    }

    function googleAutocomplete(query) {
      return new Promise((resolve) => {
        if (!googleAutocompleteService) {
          resolve([]);
          return;
        }

        googleAutocompleteService.getPlacePredictions(
          {
            input: query,
            language: "sr"
          },
          (predictions, status) => {
            if (status !== global.google.maps.places.PlacesServiceStatus.OK || !Array.isArray(predictions)) {
              resolve([]);
              return;
            }

            const mapped = predictions.slice(0, 6).map((prediction) => ({
              label: String(prediction.description || ""),
              placeId: String(prediction.place_id || "")
            })).filter((item) => item.label && item.placeId);

            resolve(mapped);
          }
        );
      });
    }

    async function searchLocationNominatim(query) {
      const endpoint = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
      const response = await fetch(endpoint, {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Pretraga nije uspela (${response.status})`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload) || payload.length === 0) {
        return null;
      }

      const hit = payload[0];
      const lat = Number(hit.lat);
      const lon = Number(hit.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }

      return {
        lat,
        lon,
        label: String(hit.display_name || query)
      };
    }

    async function searchLocation(query) {
      const hasGoogle = await loadGoogleMapsProvider();
      if (hasGoogle) {
        const googleResult = await googleGeocodeAddress(query);
        if (googleResult) {
          return googleResult;
        }
      }

      return searchLocationNominatim(query);
    }

    async function fetchLocationSuggestionsNominatim(query) {
      const endpoint = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`;
      const response = await fetch(endpoint, {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Sugestije nisu dostupne (${response.status})`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        return [];
      }

      return payload
        .map((item) => {
          const lat = Number(item.lat);
          const lon = Number(item.lon);
          const label = String(item.display_name || "").trim();
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || !label) {
            return null;
          }

          return { lat, lon, label };
        })
        .filter(Boolean);
    }

    async function fetchLocationSuggestions(query) {
      const hasGoogle = await loadGoogleMapsProvider();
      if (hasGoogle) {
        const googleItems = await googleAutocomplete(query);
        if (googleItems.length > 0) {
          return googleItems;
        }
      }

      return fetchLocationSuggestionsNominatim(query);
    }

    function hideLocationSuggestions() {
      locationSearchSuggestions.hidden = true;
      locationSearchSuggestions.innerHTML = "";
    }

    function moveToLocation(result) {
      const point = [result.lat, result.lon];
      map.setView(point, Math.max(map.getZoom(), 14));

      if (locationSearchHighlight) {
        locationSearchHighlight.remove();
        locationSearchHighlight = null;
      }

      if (locationSearchHighlightTimeoutId) {
        global.clearTimeout(locationSearchHighlightTimeoutId);
        locationSearchHighlightTimeoutId = null;
      }

      locationSearchHighlight = L.circle(point, {
        radius: 120,
        color: "#4a9eff",
        weight: 2,
        fillColor: "#4a9eff",
        fillOpacity: 0.22
      }).addTo(map);

      locationSearchHighlightTimeoutId = global.setTimeout(() => {
        if (locationSearchHighlight) {
          locationSearchHighlight.remove();
          locationSearchHighlight = null;
        }
        locationSearchHighlightTimeoutId = null;
      }, 3000);

      locationSearchInput.value = "";
    }

    function renderLocationSuggestions(items) {
      if (!items.length) {
        hideLocationSuggestions();
        return;
      }

      locationSearchSuggestions.innerHTML = "";
      items.forEach((item) => {
        const row = document.createElement("li");
        row.className = "location-search-suggestion-item";

        const button = document.createElement("button");
        button.type = "button";
        button.className = "location-search-suggestion-btn";
        button.textContent = item.label;
        button.addEventListener("click", async () => {
          locationSearchInput.value = item.label;
          hideLocationSuggestions();

          if (item.placeId) {
            const resolved = await googleGeocodePlaceId(item.placeId, item.label);
            if (resolved) {
              moveToLocation(resolved);
              return;
            }
          }

          moveToLocation(item);
        });

        row.appendChild(button);
        locationSearchSuggestions.appendChild(row);
      });

      locationSearchSuggestions.hidden = false;
    }

    locationSearchInput.addEventListener("input", () => {
      const query = locationSearchInput.value.trim();
      if (locationSearchDebounceId) {
        global.clearTimeout(locationSearchDebounceId);
      }

      if (query.length < 2) {
        hideLocationSuggestions();
        return;
      }

      locationSearchDebounceId = global.setTimeout(async () => {
        const token = ++locationSearchRequestToken;
        try {
          const items = await fetchLocationSuggestions(query);
          if (token !== locationSearchRequestToken) {
            return;
          }
          renderLocationSuggestions(items);
        } catch (error) {
          console.warn("[Search] Sugestije greška:", error.message);
          hideLocationSuggestions();
        }
      }, 220);
    });

    locationSearchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideLocationSuggestions();
      }
    });

    document.addEventListener("click", (event) => {
      if (!locationSearchForm.contains(event.target)) {
        hideLocationSuggestions();
      }
    });

    locationSearchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      hideLocationSuggestions();

      const query = locationSearchInput.value.trim();
      if (!query) {
        return;
      }

      const submitButton = locationSearchForm.querySelector("button[type='submit']");
      submitButton.disabled = true;
      submitButton.textContent = "Tražim...";

      try {
        const result = await searchLocation(query);

        if (!result) {
          alert("Lokacija nije pronađena.");
          return;
        }

        moveToLocation(result);
      } catch (error) {
        console.error("[Search] Greška:", error.message);
        alert("Greška pri pretrazi lokacije.");
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Traži";
      }
    });
  }

  global.initLocationSearch = initLocationSearch;
})(window);
