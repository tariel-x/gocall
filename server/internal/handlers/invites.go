package handlers

import (
	"net/http"
	"familycall/server/internal/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type CreateInviteRequest struct {
	ContactName string `json:"contact_name" binding:"required,min=3,max=100"`
}

func (h *Handlers) CreateInvite(c *gin.Context) {
	userID, _ := c.Get("user_id")

	// Check if current user is the first user
	var currentUser models.User
	if err := h.db.First(&currentUser, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	isFirstUser := currentUser.InvitedByUserID == nil || userCount == 1
	
	if userCount > 1 && currentUser.InvitedByUserID == nil {
		var oldestUser models.User
		h.db.Order("created_at ASC").First(&oldestUser)
		isFirstUser = oldestUser.ID == currentUser.ID
	}
	
	if !isFirstUser {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the family organizer can invite new users"})
		return
	}

	var req CreateInviteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Check if user with this username already exists
	var existingUser models.User
	if err := h.db.Where("username = ?", req.ContactName).First(&existingUser).Error; err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "User with this name already exists"})
		return
	}

	// Create invite - this will create a user when accepted
	invite := models.Invite{
		FromUserID:  userID.(string),
		ContactName: req.ContactName,
	}

	if err := h.db.Create(&invite).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create invite"})
		return
	}

	h.db.Preload("FromUser").First(&invite, invite.ID)

	c.JSON(http.StatusCreated, invite)
}

func (h *Handlers) GetInvite(c *gin.Context) {
	uuid := c.Param("uuid")

	var invite models.Invite
	if err := h.db.Preload("FromUser").Where("uuid = ?", uuid).First(&invite).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Invite not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Check if invite was already accepted (user with this name exists)
	var existingUser models.User
	contactExists := false
	
	if h.db.Where("username = ?", invite.ContactName).First(&existingUser).Error == nil {
		contactExists = true
	}

	response := gin.H{
		"id":           invite.ID,
		"uuid":         invite.UUID,
		"from_user_id": invite.FromUserID,
		"contact_name": invite.ContactName,
		"created_at":   invite.CreatedAt,
		"from_user":    invite.FromUser,
		"accepted":     contactExists,
	}

	c.JSON(http.StatusOK, response)
}

// GetPendingInvites returns all pending invites (not yet accepted) for the first user
func (h *Handlers) GetPendingInvites(c *gin.Context) {
	userID, _ := c.Get("user_id")

	// Check if current user is the first user
	var currentUser models.User
	if err := h.db.First(&currentUser, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	isFirstUser := currentUser.InvitedByUserID == nil || userCount == 1
	
	if userCount > 1 && currentUser.InvitedByUserID == nil {
		var oldestUser models.User
		h.db.Order("created_at ASC").First(&oldestUser)
		isFirstUser = oldestUser.ID == currentUser.ID
	}
	
	if !isFirstUser {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the family organizer can view pending invites"})
		return
	}

	// Get all invites created by this user
	var invites []models.Invite
	if err := h.db.Preload("FromUser").Where("from_user_id = ?", userID).Order("created_at DESC").Find(&invites).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch invites"})
		return
	}

	// Filter to only pending invites (where user with contact_name doesn't exist)
	var pendingInvites []gin.H
	for _, invite := range invites {
		var existingUser models.User
		if h.db.Where("username = ?", invite.ContactName).First(&existingUser).Error != nil {
			// User doesn't exist, invite is pending
			pendingInvites = append(pendingInvites, gin.H{
				"id":           invite.ID,
				"uuid":         invite.UUID,
				"contact_name": invite.ContactName,
				"created_at":   invite.CreatedAt,
				"invite_link":  "/invite/" + invite.UUID,
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"pending_invites": pendingInvites,
	})
}

// DeleteInvite deletes an invite (only first user can do this)
func (h *Handlers) DeleteInvite(c *gin.Context) {
	userID, _ := c.Get("user_id")
	inviteID := c.Param("id")

	// Check if current user is the first user
	var currentUser models.User
	if err := h.db.First(&currentUser, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	isFirstUser := currentUser.InvitedByUserID == nil || userCount == 1
	
	if userCount > 1 && currentUser.InvitedByUserID == nil {
		var oldestUser models.User
		h.db.Order("created_at ASC").First(&oldestUser)
		isFirstUser = oldestUser.ID == currentUser.ID
	}
	
	if !isFirstUser {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the family organizer can delete invites"})
		return
	}

	// Get the invite
	var invite models.Invite
	if err := h.db.Where("id = ? AND from_user_id = ?", inviteID, userID).First(&invite).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Invite not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Check if invite was already accepted (user with contact_name exists)
	var existingUser models.User
	if h.db.Where("username = ?", invite.ContactName).First(&existingUser).Error == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot delete invite that has already been accepted"})
		return
	}

	// Delete the invite
	if err := h.db.Delete(&invite).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete invite"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Invite deleted successfully"})
}

func (h *Handlers) AcceptInvite(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uuid := c.Param("uuid")

	// Get the invite
	var invite models.Invite
	if err := h.db.Preload("FromUser").Where("uuid = ?", uuid).First(&invite).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Invite not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Prevent self-invite
	if invite.FromUserID == userID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot accept your own invite"})
		return
	}

	// Check if user with this name already exists
	var existingUser models.User
	if err := h.db.Where("username = ?", invite.ContactName).First(&existingUser).Error; err == nil {
		// User already exists - they've already been created, just return success
		c.JSON(http.StatusOK, gin.H{
			"message": "Invite already accepted",
			"user": existingUser,
		})
		return
	}

	// Get the accepting user
	var acceptingUser models.User
	if err := h.db.First(&acceptingUser, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to find accepting user"})
		return
	}

	// Update accepting user's username to the contact name from invite
	// This makes User = Contact with the same UUID
	acceptingUser.Username = invite.ContactName
	acceptingUser.InvitedByUserID = &invite.FromUserID
	
	if err := h.db.Save(&acceptingUser).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update user"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Invite accepted",
		"user": acceptingUser,
	})
}

// GetInviteForContact gets or creates an invite link for an existing contact (user)
func (h *Handlers) GetInviteForContact(c *gin.Context) {
	userID, _ := c.Get("user_id")
	contactID := c.Param("contact_id")

	// Get the contact user
	var contactUser models.User
	if err := h.db.Where("id = ? AND id != ?", contactID, userID).First(&contactUser).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Contact not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Find existing invite for this contact name, or create a new one
	var invite models.Invite
	err := h.db.Where("from_user_id = ? AND contact_name = ?", userID, contactUser.Username).First(&invite).Error
	
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			// Create new invite
			invite = models.Invite{
				FromUserID:  userID.(string),
				ContactName: contactUser.Username,
			}
			if err := h.db.Create(&invite).Error; err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create invite"})
				return
			}
			h.db.Preload("FromUser").First(&invite, invite.ID)
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			return
		}
	} else {
		// Load existing invite with user info
		h.db.Preload("FromUser").First(&invite, invite.ID)
	}

	c.JSON(http.StatusOK, gin.H{
		"invite":      invite,
		"invite_link": "/invite/" + invite.UUID,
	})
}

