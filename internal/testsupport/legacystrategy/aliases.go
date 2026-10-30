// Package legacystrategy contains frozen pre-exit fixture algorithms. Only test
// files may import it; Lake must not depend on this package.
package legacystrategy

import "github.com/Clean-Lakes/Lake/internal/strategy"

type AssetKind = strategy.AssetKind
type AssetRevision = strategy.AssetRevision
type RevisionRef = strategy.RevisionRef
type OmittedAsset = strategy.OmittedAsset
type Selection = strategy.Selection
type SelectionReason = strategy.SelectionReason

const UserPreference = strategy.UserPreference
const DomainProcedure = strategy.DomainProcedure
const ToolGuidance = strategy.ToolGuidance
const ReportGuidance = strategy.ReportGuidance

var ContentHash = strategy.ContentHash
var ComparableContent = strategy.ComparableContent
