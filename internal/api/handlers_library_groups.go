package api

import (
	"net/http"
	"strconv"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 媒体库分组（用户 2026-09-22）：一个库最多属于一个组，空串 = 未分组。
// 组只做三件事：归类显示、批量操作、批量授权；**访问判据仍只在 storage.UserLibraryIDs**
// （直授 ∪ 组授），本文件不参与鉴权，只写组与归属。

// HandleListLibraryGroups 列出全部组（带成员库数），按 sort_order/名称排序。
func (s *Server) HandleListLibraryGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.DB.ListLibraryGroups()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"list": groups}, nil)
}

type libraryGroupReq struct {
	Name      string `json:"name"`
	SortOrder *int   `json:"sort_order"`
}

// HandleCreateLibraryGroup 建组（重名 409，人话提示）。
func (s *Server) HandleCreateLibraryGroup(w http.ResponseWriter, r *http.Request) {
	var req libraryGroupReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	order := 0
	if req.SortOrder != nil {
		order = *req.SortOrder
	}
	g, err := s.DB.CreateLibraryGroup(req.Name, order)
	if err != nil {
		s.audit(r, "library_group.create", req.Name, false, errCode(err))
		s.fail(w, r, err)
		return
	}
	s.audit(r, "library_group.create", "group:"+g.ID, true, g.Name)
	respond(w, http.StatusOK, g, nil)
}

// HandlePatchLibraryGroup 改名 / 改排序（都不传 = 原样回读，不写空值）。
func (s *Server) HandlePatchLibraryGroup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req libraryGroupReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	var name *string
	if req.Name != "" {
		name = &req.Name
	}
	g, err := s.DB.UpdateLibraryGroup(id, name, req.SortOrder)
	if err != nil {
		s.audit(r, "library_group.update", "group:"+id, false, errCode(err))
		s.fail(w, r, err)
		return
	}
	s.audit(r, "library_group.update", "group:"+id, true, g.Name)
	respond(w, http.StatusOK, g, nil)
}

// HandleDeleteLibraryGroup 删组：只解绑（库回到"未分组"），绝不删库。
// 响应带真实解绑库数，界面照它说话。
func (s *Server) HandleDeleteLibraryGroup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	unbound, err := s.DB.DeleteLibraryGroup(id)
	if err != nil {
		s.audit(r, "library_group.delete", "group:"+id, false, errCode(err))
		s.fail(w, r, err)
		return
	}
	s.audit(r, "library_group.delete", "group:"+id, true, "unbound:"+strconv.FormatInt(unbound, 10))
	respond(w, http.StatusOK, map[string]any{"unbound_libraries": unbound}, nil)
}

type assignLibraryGroupReq struct {
	GroupID string `json:"group_id"`
}

// HandleSetLibraryGroup 把一个库归入某组（group_id 空串 = 移出到未分组）。
func (s *Server) HandleSetLibraryGroup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req assignLibraryGroupReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.DB.SetLibraryGroup(id, req.GroupID); err != nil {
		s.audit(r, "library_group.assign", "library:"+id, false, errCode(err))
		s.fail(w, r, err)
		return
	}
	lib, err := s.DB.GetLibrary(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.audit(r, "library_group.assign", "library:"+id, true, "group:"+req.GroupID)
	respond(w, http.StatusOK, lib, nil)
}

type groupLibrariesReq struct {
	LibraryIDs []string `json:"library_ids"`
}

// HandlePutGroupLibraries 批量归组：把列出的库整体移进这个组（一次事务）。
// 想把库移出组请用单库接口传空 group_id —— 这个入口不接受空目标组，避免"手滑清空整组"。
func (s *Server) HandlePutGroupLibraries(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req groupLibrariesReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	ids := cleanIDs(req.LibraryIDs)
	if _, err := s.DB.GetLibraryGroup(id); err != nil {
		s.fail(w, r, err)
		return
	}
	moved, err := s.DB.SetLibrariesGroup(ids, id)
	if err != nil {
		s.audit(r, "library_group.assign_batch", "group:"+id, false, errCode(err))
		s.fail(w, r, err)
		return
	}
	g, err := s.DB.GetLibraryGroup(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.audit(r, "library_group.assign_batch", "group:"+id, true, "moved:"+strconv.FormatInt(moved, 10))
	respond(w, http.StatusOK, map[string]any{"group": g, "moved": moved, "requested": len(ids)}, nil)
}

type groupActionReq struct {
	Action string `json:"action"`
}

// HandleLibraryGroupAction 整组操作：enable / disable / scan。
// 计数一律以后端实际影响为准（改动行数 / 真正启动的扫描），失败逐条如实回报。
func (s *Server) HandleLibraryGroupAction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req groupActionReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	action := req.Action
	if action != "enable" && action != "disable" && action != "scan" {
		s.fail(w, r, domain.New("VALIDATION_GROUP_ACTION", "只支持 enable / disable / scan", 400))
		return
	}
	if _, err := s.DB.GetLibraryGroup(id); err != nil {
		s.fail(w, r, err)
		return
	}

	if action == "enable" || action == "disable" {
		changed, err := s.DB.SetGroupEnabled(id, action == "enable")
		if err != nil {
			s.audit(r, "library_group.action", "group:"+id, false, errCode(err))
			s.fail(w, r, err)
			return
		}
		s.audit(r, "library_group.action", "group:"+id, true, action+":"+strconv.FormatInt(changed, 10))
		respond(w, http.StatusOK, map[string]any{"action": action, "changed": changed}, nil)
		return
	}

	// scan：逐库入队；单库失败不影响其它库，失败原因照样回报（不谎报"全部已启动"）。
	libs, err := s.DB.ListLibrariesInGroup(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	taskIDs := []string{}
	failed := []map[string]string{}
	for _, lib := range libs {
		if !lib.Enabled {
			failed = append(failed, map[string]string{"library_id": lib.ID, "name": lib.Name, "error": "库已停用，未扫描"})
			continue
		}
		t, err := s.Tasks.StartScan(lib.ID, "incremental")
		if err != nil {
			failed = append(failed, map[string]string{"library_id": lib.ID, "name": lib.Name, "error": err.Error()})
			continue
		}
		taskIDs = append(taskIDs, t.ID)
	}
	s.audit(r, "library_group.action", "group:"+id, true, "scan:"+strconv.Itoa(len(taskIDs)))
	respond(w, http.StatusAccepted, map[string]any{
		"action": "scan", "total": len(libs), "started": len(taskIDs),
		"task_ids": taskIDs, "failed": failed,
	}, nil)
}

// ============================================================================
//  用户 ↔ 组授权（与逐库直授并存，判据见 storage.UserLibraryIDs 的并集查询）
// ============================================================================

type userLibraryGroupsReq struct {
	GroupIDs []string `json:"group_ids"`
}

// HandleGetUserLibraryGroups 回读某用户的组授行。
func (s *Server) HandleGetUserLibraryGroups(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.DB.GetUserByID(id); err != nil {
		s.fail(w, r, err)
		return
	}
	grants, err := s.DB.ListUserLibraryGroupGrants(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ids := make([]string, 0, len(grants))
	for _, g := range grants {
		ids = append(ids, g.GroupID)
	}
	respond(w, http.StatusOK, map[string]any{"user_id": id, "group_ids": ids, "grants": grants}, nil)
}

// HandlePutUserLibraryGroups 整体替换组授：未勾选整行删除，提交后回读真实行。
// 直授行不受影响（并集语义）。
func (s *Server) HandlePutUserLibraryGroups(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req userLibraryGroupsReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if _, err := s.DB.GetUserByID(id); err != nil {
		s.fail(w, r, err)
		return
	}
	grants, err := s.DB.SetUserLibraryGroups(id, cleanIDs(req.GroupIDs))
	if err != nil {
		s.audit(r, "user.library_groups", "user:"+id, false, errCode(err))
		s.fail(w, r, err)
		return
	}
	ids := make([]string, 0, len(grants))
	for _, g := range grants {
		ids = append(ids, g.GroupID)
	}
	s.audit(r, "user.library_groups", "user:"+id, true, "count:"+strconv.Itoa(len(ids)))
	respond(w, http.StatusOK, map[string]any{"user_id": id, "group_ids": ids, "grants": grants}, nil)
}
