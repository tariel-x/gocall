package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Invite struct {
	ID        string    `gorm:"type:varchar(36);primaryKey" json:"id"`
	UUID      string    `gorm:"type:varchar(36);uniqueIndex;not null" json:"uuid"`
	FromUserID string   `gorm:"type:varchar(36);not null;index" json:"from_user_id"`
	ContactName string  `gorm:"type:varchar(100);not null" json:"contact_name"`
	CreatedAt time.Time `json:"created_at"`

	// Relations
	FromUser User `gorm:"foreignKey:FromUserID" json:"from_user"`
}

func (i *Invite) BeforeCreate(tx *gorm.DB) error {
	if i.ID == "" {
		i.ID = uuid.New().String()
	}
	if i.UUID == "" {
		i.UUID = uuid.New().String()
	}
	return nil
}

