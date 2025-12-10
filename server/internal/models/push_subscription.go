package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type PushSubscription struct {
	ID        string    `gorm:"type:varchar(36);primaryKey" json:"id"`
	UserID    string    `gorm:"type:varchar(36);not null;index" json:"user_id"`
	Endpoint  string    `gorm:"type:text;not null" json:"endpoint"`
	P256DH    string    `gorm:"type:text;not null" json:"p256dh"`
	Auth      string    `gorm:"type:text;not null" json:"auth"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// Relations
	User User `gorm:"foreignKey:UserID" json:"-"`
}

func (p *PushSubscription) BeforeCreate(tx *gorm.DB) error {
	if p.ID == "" {
		p.ID = uuid.New().String()
	}
	return nil
}

