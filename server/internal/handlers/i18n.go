package handlers

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)


// GetTranslations returns translations for the specified language
func (h *Handlers) GetTranslations(c *gin.Context) {
	lang := c.Param("lang")
	if lang == "" {
		lang = "en" // Default to English
	}

	// Only allow en and ru
	if lang != "en" && lang != "ru" {
		lang = "en"
	}

	// Read translation file
	filePath := "translations/" + lang + ".json"
	data, err := h.translationsFS.ReadFile(filePath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Translation file not found"})
		return
	}

	log.Printf("[I18N] Read file '%s': %d bytes", filePath, len(data))

	// Parse JSON
	var translations map[string]string
	if err := json.Unmarshal(data, &translations); err != nil {
		log.Printf("[I18N] JSON parse error for '%s': %v", lang, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to parse translations"})
		return
	}

	// Log for debugging
	log.Printf("[I18N] Serving translations for language '%s': %d keys", lang, len(translations))
	
	// Log first few keys for verification
	keyCount := 0
	for k := range translations {
		if keyCount < 5 {
			log.Printf("[I18N] Sample key %d: %s", keyCount+1, k)
		}
		keyCount++
	}

	// Set cache headers to prevent caching
	c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	c.Header("Pragma", "no-cache")
	c.Header("Expires", "0")
	
	c.JSON(http.StatusOK, translations)
}

