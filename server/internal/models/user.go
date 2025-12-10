package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type User struct {
	ID            string    `gorm:"type:varchar(36);primaryKey" json:"id"`
	Username      string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"username"`
	InvitedByUserID *string `gorm:"type:varchar(36);index" json:"invited_by_user_id,omitempty"` // Who invited this user
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

func (u *User) BeforeCreate(tx *gorm.DB) error {
	if u.ID == "" {
		u.ID = uuid.New().String()
	}
	return nil
}

