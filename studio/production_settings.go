package studio

import (
	"context"
	"database/sql"
	"errors"
)

type productionSpec struct {
	AspectRatio           string `json:"aspectRatio"`
	TargetDurationSeconds *int64 `json:"targetDurationSeconds"`
}

func (spec productionSpec) valid() bool {
	return (spec.AspectRatio == "" || spec.AspectRatio == "16:9" || spec.AspectRatio == "9:16") &&
		(spec.TargetDurationSeconds == nil || *spec.TargetDurationSeconds > 0)
}

func readProductionSpec(ctx context.Context, db rowQuery) (productionSpec, error) {
	var spec productionSpec
	err := db.QueryRowContext(ctx, `SELECT aspect_ratio,target_duration_seconds FROM workspace_production WHERE singleton=1`).
		Scan(&spec.AspectRatio, &spec.TargetDurationSeconds)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return spec, err
}

func setAutomaticPermission(ctx context.Context, tx *sql.Tx, sessionID string, enabled bool) (int64, error) {
	statement := "DELETE FROM temp.session_permission WHERE session_id=?"
	if enabled {
		statement = "INSERT INTO temp.session_permission VALUES(?)"
	}
	if _, err := tx.ExecContext(ctx, statement, sessionID); err != nil {
		return 0, err
	}
	return addEvent(ctx, tx, "permission", []string{sessionID})
}

type productionSettings struct {
	Spec         productionSpec `json:"productionSpec"`
	AutoGenerate bool           `json:"autoGenerate"`
}

type productionSettingsArgs struct {
	operation
	Spec         *productionSpec `json:"productionSpec"`
	AutoGenerate *bool           `json:"autoGenerate"`
}

func (s *Service) executeProductionSettings(ctx context.Context, r Request) (any, error) {
	if r.Actor != "human" {
		return nil, humanWriteOnly
	}
	if r.Action == "production_settings_get" {
		if err := decodeData(r.Data, &struct{}{}); err != nil {
			return nil, err
		}
		var out productionSettings
		p, err := s.open(ctx, r.WorkspacePath, false)
		if err != nil || p == nil {
			return out, err
		}
		tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		out.Spec, err = readProductionSpec(ctx, tx)
		if err != nil {
			return nil, err
		}
		status, err := getStatus(ctx, tx, r)
		out.AutoGenerate = status.AutoGenerate
		return out, err
	}

	var args productionSettingsArgs
	if err := decodeData(r.Data, &args); err != nil {
		return nil, err
	}
	if err := args.operation.validate(); err != nil {
		return nil, err
	}
	if args.Spec == nil && args.AutoGenerate == nil {
		return nil, invalid("请选择要保存的制作设置")
	}
	if args.Spec != nil && !args.Spec.valid() {
		return nil, invalid("请选择支持的成片画幅，并填写正整数秒数或留空")
	}
	p, err := s.open(ctx, r.WorkspacePath, true)
	if err != nil {
		return nil, err
	}
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, status Status) (any, error) {
		spec, err := readProductionSpec(ctx, tx)
		if err != nil {
			return nil, err
		}
		if args.Spec != nil {
			if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_production(singleton,aspect_ratio,target_duration_seconds)
				VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET aspect_ratio=excluded.aspect_ratio,
				target_duration_seconds=excluded.target_duration_seconds`, args.Spec.AspectRatio, args.Spec.TargetDurationSeconds); err != nil {
				return nil, err
			}
			if workflowSpecPrefix(spec) != workflowSpecPrefix(*args.Spec) {
				if _, err := tx.ExecContext(ctx, `UPDATE workflow_handoffs SET stale=1 WHERE revision IS NOT NULL AND stale=0`); err != nil {
					return nil, err
				}
				if _, err := expireWorkflowKickoffs(ctx, tx, ""); err != nil {
					return nil, err
				}
				if _, err := addEvent(ctx, tx, "workflow", []string{r.SessionID}); err != nil {
					return nil, err
				}
			}
			spec = *args.Spec
		}
		automatic := status.AutoGenerate
		if args.AutoGenerate != nil && automatic != *args.AutoGenerate {
			if _, err := setAutomaticPermission(ctx, tx, r.SessionID, *args.AutoGenerate); err != nil {
				return nil, err
			}
			automatic = *args.AutoGenerate
		}
		return productionSettings{Spec: spec, AutoGenerate: automatic}, nil
	})
}
