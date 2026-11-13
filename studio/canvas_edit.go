package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
)

type canvasNodeVersion struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}

type canvasEdgeVersion struct {
	Edge
	Revision int64 `json:"revision"`
	Position int   `json:"position"`
}

type canvasChangeArgs struct {
	operation
	Nodes []canvasNodeVersion `json:"nodes"`
	Edges []canvasEdgeVersion `json:"edges"`
}

type canvasChangeResult struct {
	Nodes    []canvasNodeVersion `json:"nodes"`
	Edges    []canvasEdgeVersion `json:"edges"`
	EventSeq int64               `json:"eventSeq"`
}

func changeCanvas(ctx context.Context, tx *sql.Tx, args canvasChangeArgs, restore bool) (canvasChangeResult, []string, error) {
	result := canvasChangeResult{Nodes: []canvasNodeVersion{}, Edges: []canvasEdgeVersion{}}
	if len(args.Nodes)+len(args.Edges) == 0 {
		return result, nil, invalid("请选择节点或连线")
	}
	touched := map[string]int64{}
	nodes := map[string]bool{}
	for _, node := range args.Nodes {
		var revision int64
		var deleted bool
		err := tx.QueryRowContext(ctx, "SELECT revision,deleted FROM nodes WHERE id=?", node.ID).Scan(&revision, &deleted)
		if errors.Is(err, sql.ErrNoRows) || err == nil && (deleted != restore || node.Revision != revision || nodes[node.ID]) {
			return result, nil, revisionConflict
		}
		if err != nil {
			return result, nil, err
		}
		nodes[node.ID] = true
		touched[node.ID] = revision
		result.Nodes = append(result.Nodes, canvasNodeVersion{ID: node.ID, Revision: revision + 1})
	}
	edgeSet := map[Edge]bool{}
	for _, edge := range args.Edges {
		if edge.Source == edge.Target || edgeSet[edge.Edge] {
			return result, nil, invalid("每条连线只能操作一次，不能连接自身")
		}
		edgeSet[edge.Edge] = true
		result.Edges = append(result.Edges, edge)
	}
	if !restore {
		for _, node := range args.Nodes {
			rows, err := tx.QueryContext(ctx, `SELECT source,target,nodes.revision FROM edges JOIN nodes ON target=nodes.id
				WHERE source=? OR target=? ORDER BY edges.rowid`, node.ID, node.ID)
			if err != nil {
				return result, nil, err
			}
			for rows.Next() {
				var edge canvasEdgeVersion
				if err := rows.Scan(&edge.Source, &edge.Target, &edge.Revision); err != nil {
					rows.Close()
					return result, nil, err
				}
				if !edgeSet[edge.Edge] {
					edgeSet[edge.Edge] = true
					result.Edges = append(result.Edges, edge)
				}
			}
			if err := errors.Join(rows.Err(), rows.Close()); err != nil {
				return result, nil, err
			}
		}
	}
	if restore {
		for _, node := range args.Nodes {
			if _, err := tx.ExecContext(ctx, "UPDATE nodes SET deleted=0 WHERE id=?", node.ID); err != nil {
				return result, nil, err
			}
		}
	}
	byTarget := map[string][]int{}
	for i, edge := range result.Edges {
		byTarget[edge.Target] = append(byTarget[edge.Target], i)
	}
	for target, indices := range byTarget {
		if err := changeCanvasTarget(ctx, tx, target, indices, &result, touched, restore); err != nil {
			return result, nil, err
		}
	}
	if !restore {
		for _, node := range args.Nodes {
			if _, err := tx.ExecContext(ctx, "UPDATE nodes SET deleted=1 WHERE id=?", node.ID); err != nil {
				return result, nil, err
			}
		}
	}
	ids := make([]string, 0, len(touched))
	for id := range touched {
		if _, err := tx.ExecContext(ctx, "UPDATE nodes SET revision=revision+1 WHERE id=?", id); err != nil {
			return result, nil, err
		}
		ids = append(ids, id)
	}
	slices.Sort(ids)
	seq, err := addEvent(ctx, tx, "update", ids)
	result.EventSeq = seq
	return result, ids, err
}

func changeCanvasTarget(ctx context.Context, tx *sql.Tx, target string, indices []int, result *canvasChangeResult, touched map[string]int64, restore bool) error {
	var kind, raw string
	var revision int64
	err := tx.QueryRowContext(ctx, "SELECT type,content,revision FROM nodes WHERE id=?", target).Scan(&kind, &raw, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return revisionConflict
	}
	if err != nil {
		return err
	}
	var content map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &content); err != nil {
		return err
	}
	order := orderedSources(content)
	if restore {
		// Each stored position refers to the order before deletion.
		slices.SortStableFunc(indices, func(a, b int) int { return result.Edges[a].Position - result.Edges[b].Position })
	}
	removed := map[string]bool{}
	for _, i := range indices {
		edge := &result.Edges[i]
		if edge.Revision != revision {
			return revisionConflict
		}
		if restore {
			if kind == "image" || kind == "video" || edge.Position >= 0 {
				if err := validateReferenceSource(ctx, tx, edge.Source, kind); err != nil {
					return err
				}
			} else if _, err := nodeType(ctx, tx, edge.Source); err != nil {
				return err
			}
			insert, err := tx.ExecContext(ctx, "INSERT INTO edges(source,target) VALUES(?,?) ON CONFLICT DO NOTHING", edge.Source, target)
			if err != nil {
				return err
			}
			if count, err := insert.RowsAffected(); err != nil {
				return err
			} else if count == 0 {
				return revisionConflict
			}
			if edge.Position >= 0 {
				if edge.Position > len(order) || slices.Contains(order, edge.Source) {
					return revisionConflict
				}
				order = slices.Insert(order, edge.Position, edge.Source)
			}
		} else {
			deletion, err := tx.ExecContext(ctx, "DELETE FROM edges WHERE source=? AND target=?", edge.Source, target)
			if err != nil {
				return err
			}
			if count, err := deletion.RowsAffected(); err != nil {
				return err
			} else if count == 0 {
				return &requestError{http.StatusNotFound, "引用连线已移除"}
			}
			edge.Position = slices.Index(order, edge.Source)
			removed[edge.Source] = true
		}
		edge.Revision = revision + 1
	}
	order = slices.DeleteFunc(order, func(id string) bool { return removed[id] })
	setOrderedSources(content, order)
	data, err := json.Marshal(content)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE nodes SET content=? WHERE id=?", string(data), target); err != nil {
		return err
	}
	if restore && kind == "video" {
		if err := validateVideo(ctx, tx, target, true); err != nil {
			return err
		}
	}
	touched[target] = revision
	return nil
}
